import {
  importGame as importGogLibraryGame,
  refreshInstalled,
  runRunnerCommand as runGogdlCommand,
  getInstallInfo,
  getLinuxInstallerInfo,
  createReqsArray,
  getGameInfo as getGogLibraryGameInfo,
  changeGameInstallPath,
  getMetaResponse,
  getProductApi,
  getGamesData
} from './library'
import { join } from 'path'
import {
  errorHandler,
  getFileSize,
  getGOGdlBin,
  spawnAsync,
  moveOnUnix,
  moveOnWindows,
  shutdownWine,
  sendProgressUpdate,
  sendGameStatusUpdate,
  getPathDiskSize
} from '../../utils'
import {
  ExtraInfo,
  GameInfo,
  ExecResult,
  InstallArgs,
  InstalledInfo,
  InstallPlatform,
  InstallProgress,
  LaunchOption,
  BaseLaunchOption
} from 'common/types'
import { appendFileSync, existsSync, rmSync } from 'graceful-fs'
import {
  gogSupportPath,
  gogdlConfigPath,
  isWindows,
  isMac,
  isLinux
} from '../../constants'
import {
  configStore,
  installedGamesStore,
  playtimeSyncQueue,
  privateBranchesStore,
  syncStore
} from './electronStores'
import {
  appendGameLog,
  logDebug,
  logError,
  logFileLocation,
  logInfo,
  LogPrefix,
  logsDisabled,
  logWarning
} from '../../logger/logger'
import { GOGUser } from './user'
import {
  getRunnerCallWithoutCredentials,
  getWinePath,
  launchCleanup,
  prepareLaunch,
  prepareWineLaunch,
  runWineCommand,
  runWineCommand as runWineCommandUtil,
  setupEnvVars,
  setupWrapperEnvVars,
  setupWrappers
} from '../../launcher'
import {
  addShortcuts as addShortcutsUtil,
  removeShortcuts as removeShortcutsUtil
} from '../../shortcuts/shortcuts/shortcuts'
import setup from './setup'
import { removeNonSteamGame } from '../../shortcuts/nonesteamgame/nonesteamgame'
import shlex from 'shlex'
import {
  GOGSessionSyncQueueItem,
  GogInstallPlatform,
  UserData
} from 'common/types/gog'
import { t } from 'i18next'
import { showDialogBoxModalAuto } from '../../dialog/dialog'
import { sendFrontendMessage } from '../../main_window'
import { RemoveArgs } from 'common/types/game_manager'
import { getWineFlagsArray } from 'backend/utils/compatibility_layers'
import axios, { AxiosError } from 'axios'
import { isOnline, runOnceWhenOnline } from 'backend/online_monitor'
import { getGlobalConfig } from '../../config/global'
import { getGameConfig } from '../../config/game'
import type { KeyValuePair } from '../../schemas'
import { readdir, readFile } from 'fs/promises'
import { statSync } from 'fs'
import ini from 'ini'
import { getRequiredRedistList, updateRedist } from './redist'

export async function getExtraInfo(appName: string): Promise<ExtraInfo> {
  const gameInfo = getGameInfo(appName)
  let targetPlatform: GogInstallPlatform = 'windows'

  if (isMac && gameInfo.is_mac_native) {
    targetPlatform = 'osx'
  } else if (isLinux && gameInfo.is_linux_native) {
    targetPlatform = 'linux'
  } else {
    targetPlatform = 'windows'
  }

  const reqs = await createReqsArray(appName, targetPlatform)
  const productInfo = await getProductApi(appName, ['changelog'])

  const gamesData = await getGamesData(appName)

  const gogStoreUrl = gamesData?._links?.store.href
  const releaseDate =
    gamesData?._embedded.product?.globalReleaseDate?.substring(0, 19)

  const storeUrl = new URL(gogStoreUrl)
  storeUrl.hostname = 'af.gog.com'
  storeUrl.searchParams.set('as', '1838482841')

  const extra: ExtraInfo = {
    about: gameInfo.extra?.about,
    reqs,
    releaseDate,
    storeUrl: storeUrl.toString(),
    changelog: productInfo?.data.changelog
  }
  return extra
}

export function getGameInfo(appName: string): GameInfo {
  const info = getGogLibraryGameInfo(appName)
  if (!info) {
    logError(
      [
        'Could not get game info for',
        `${appName},`,
        'returning empty object. Something is probably gonna go wrong soon'
      ],
      LogPrefix.Gog
    )
    return {
      app_name: '',
      runner: 'gog',
      art_cover: '',
      art_square: '',
      install: {},
      is_installed: false,
      title: '',
      canRunOffline: false
    }
  }
  return info
}

export async function importGame(
  appName: string,
  folderPath: string,
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  platform: InstallPlatform
): Promise<ExecResult> {
  const res = await runGogdlCommand(['import', folderPath], {
    abortId: appName,
    logMessagePrefix: `Importing ${appName}`
  })

  if (res.abort) {
    return res
  }

  if (res.error) {
    logError(['Failed to import', `${appName}:`, res.error], LogPrefix.Gog)
    return res
  }

  try {
    await importGogLibraryGame(JSON.parse(res.stdout), folderPath)
    addShortcuts(appName)
  } catch (error) {
    logError(['Failed to import', `${appName}:`, error], LogPrefix.Gog)
  }

  return res
}

interface tmpProgressMap {
  [key: string]: InstallProgress
}

function defaultTmpProgress() {
  return {
    bytes: '',
    eta: '',
    percent: undefined,
    diskSpeed: undefined,
    downSpeed: undefined
  }
}
const tmpProgress: tmpProgressMap = {}

export function onInstallOrUpdateOutput(
  appName: string,
  action: 'installing' | 'updating',
  data: string,
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  totalDownloadSize = -1
) {
  if (!Object.hasOwn(tmpProgress, appName)) {
    tmpProgress[appName] = defaultTmpProgress()
  }
  const progress = tmpProgress[appName]

  // parse log for percent
  if (!progress.percent) {
    const percentMatch = data.match(/Progress: (\d+\.\d+) /m)

    progress.percent = !Number.isNaN(Number(percentMatch?.at(1)))
      ? Number(percentMatch?.at(1))
      : undefined
  }

  // parse log for eta
  if (progress.eta === '') {
    const etaMatch = data.match(/ETA: (\d\d:\d\d:\d\d)/m)
    progress.eta = etaMatch && etaMatch?.length >= 2 ? etaMatch[1] : ''
  }

  // parse log for game download progress
  if (progress.bytes === '') {
    const bytesMatch = data.match(/Downloaded: (\S+) MiB/m)
    progress.bytes =
      bytesMatch && bytesMatch?.length >= 2 ? `${bytesMatch[1]}MB` : ''
  }

  // parse log for download speed
  if (!progress.downSpeed) {
    const downSpeedMBytes = data.match(/Download\t- (\S+.) MiB/m)
    progress.downSpeed = !Number.isNaN(Number(downSpeedMBytes?.at(1)))
      ? Number(downSpeedMBytes?.at(1))
      : undefined
  }

  // parse disk write speed
  if (!progress.diskSpeed) {
    const diskSpeedMBytes = data.match(/Disk\t- (\S+.) MiB/m)
    progress.diskSpeed = !Number.isNaN(Number(diskSpeedMBytes?.at(1)))
      ? Number(diskSpeedMBytes?.at(1))
      : undefined
  }

  // only send to frontend if all values are updated
  if (
    Object.values(progress).every(
      (value) => !(value === undefined || value === '')
    )
  ) {
    logInfo(
      [
        `Progress for ${getGameInfo(appName).title}:`,
        `${progress.percent}%/${progress.bytes}/${progress.eta}`.trim(),
        `Down: ${progress.downSpeed}MB/s / Disk: ${progress.diskSpeed}MB/s`
      ],
      LogPrefix.Gog
    )

    sendProgressUpdate({
      appName: appName,
      runner: 'gog',
      status: action,
      progress: progress
    })

    // reset
    tmpProgress[appName] = defaultTmpProgress()
  }
}

export async function install(
  appName: string,
  {
    path,
    installDlcs,
    platformToInstall,
    installLanguage,
    build,
    branch
  }: InstallArgs
): Promise<{
  status: 'done' | 'error' | 'abort'
  error?: string
}> {
  const { maxDownloadWorkers } = getGlobalConfig()
  const workers = maxDownloadWorkers
    ? ['--max-workers', `${maxDownloadWorkers}`]
    : []
  const privateBranchPassword = privateBranchesStore.get(appName, '')
  const withDlcs = installDlcs?.length
    ? ['--with-dlcs', '--dlcs', installDlcs.join(',')]
    : ['--skip-dlcs']

  const buildArgs = build ? ['--build', build] : []
  const branchArgs = branch ? ['--branch', branch] : []

  const credentials = await GOGUser.getCredentials()

  if (!credentials) {
    logError(
      ['Failed to install', `${appName}:`, 'No credentials'],
      LogPrefix.Gog
    )
    return { status: 'error' }
  }

  const installPlatform =
    platformToInstall === 'Mac'
      ? 'osx'
      : (platformToInstall.toLowerCase() as GogInstallPlatform)

  const commandParts: string[] = [
    'download',
    appName,
    '--platform',
    installPlatform,
    '--path',
    path,
    '--support',
    join(gogSupportPath, appName),
    ...withDlcs,
    '--lang',
    String(installLanguage),
    ...buildArgs,
    ...branchArgs,
    ...workers
  ]

  if (privateBranchPassword.length) {
    commandParts.push('--password', privateBranchPassword)
  }

  const onOutput = (data: string) => {
    onInstallOrUpdateOutput(appName, 'installing', data)
  }

  const res = await runGogdlCommand(commandParts, {
    abortId: appName,
    logFile: logFileLocation(appName),
    onOutput,
    logMessagePrefix: `Installing ${appName}`
  })

  if (res.abort) {
    return { status: 'abort' }
  }

  if (res.error) {
    logError(
      ['Failed to install GOG game ', `${appName}:`, res.error],
      LogPrefix.Gog
    )
    return { status: 'error', error: res.error }
  }

  // Installation succeded
  // Save new game info to installed games store
  const installInfo = await getInstallInfo(
    appName,
    installPlatform,
    branch,
    build
  )
  if (installInfo === undefined) {
    logError('install info is undefined in GOG install', LogPrefix.Gog)
    return { status: 'error' }
  }
  const gameInfo = getGameInfo(appName)
  const isLinuxNative = installPlatform === 'linux'
  const additionalInfo = isLinuxNative
    ? await getLinuxInstallerInfo(appName)
    : null

  if (gameInfo.folder_name === undefined || gameInfo.folder_name.length === 0) {
    logError('game info folder is undefined in GOG install', LogPrefix.Gog)
    return { status: 'error' }
  }

  const sizeOnDisk = await getPathDiskSize(join(path, gameInfo.folder_name))

  const installedData: InstalledInfo = {
    platform: installPlatform,
    executable: '',
    install_path: join(path, gameInfo.folder_name),
    install_size: getFileSize(sizeOnDisk),
    is_dlc: false,
    version: additionalInfo ? additionalInfo.version : installInfo.game.version,
    appName: appName,
    installedDLCs: installDlcs,
    language: installLanguage,
    versionEtag: isLinuxNative ? '' : installInfo.manifest.versionEtag,
    buildId: isLinuxNative ? '' : installInfo.game.buildId,
    pinnedVersion: !!build
  }
  const array = installedGamesStore.get('installed', [])
  array.push(installedData)
  installedGamesStore.set('installed', array)
  gameInfo.is_installed = true
  gameInfo.install = installedData
  refreshInstalled()
  if (isWindows) {
    logInfo('Windows os, running setup instructions on install', LogPrefix.Gog)
    try {
      await setup(appName, installedData)
    } catch (e) {
      logWarning(
        [
          `Failed to run setup instructions on install for ${gameInfo.title}`,
          'Error:',
          e
        ],
        LogPrefix.Gog
      )
    }
  }
  addShortcuts(appName)
  return { status: 'done' }
}

export function isNative(appName: string): boolean {
  const gameInfo = getGameInfo(appName)
  if (isWindows) {
    return true
  }

  if (isMac && gameInfo.install.platform === 'osx') {
    return true
  }

  if (isLinux && gameInfo.install.platform === 'linux') {
    return true
  }

  return false
}

export async function addShortcuts(appName: string, fromMenu?: boolean) {
  return addShortcutsUtil(getGameInfo(appName), fromMenu)
}

export async function removeShortcuts(appName: string) {
  return removeShortcutsUtil(getGameInfo(appName))
}

export async function launch(
  appName: string,
  launchArguments?: LaunchOption
): Promise<boolean> {
  const gameConfig = getGameConfig(appName, 'gog')
  const gameInfo = getGameInfo(appName)

  if (
    !gameInfo.install ||
    !gameInfo.install.install_path ||
    !gameInfo.install.platform
  ) {
    return false
  }

  if (!existsSync(gameInfo.install.install_path)) {
    errorHandler({
      error: 'appears to be deleted',
      runner: 'gog',
      appName: gameInfo.app_name
    })
    return false
  }

  const {
    success: launchPrepSuccess,
    failureReason: launchPrepFailReason,
    rpcClient,
    mangoHudCommand,
    gameScopeCommand,
    gameModeBin,
    steamRuntime
  } = await prepareLaunch(gameConfig, gameInfo, isNative(appName))
  if (!launchPrepSuccess) {
    appendGameLog(gameInfo, `Launch aborted: ${launchPrepFailReason}`)
    showDialogBoxModalAuto({
      title: t('box.error.launchAborted', 'Launch aborted'),
      message: launchPrepFailReason!,
      type: 'ERROR'
    })
    return false
  }

  const exeOverrideFlag = gameConfig.targetExe
    ? ['--override-exe', gameConfig.targetExe]
    : []

  let commandEnv = {
    ...process.env,
    ...setupWrapperEnvVars({ appName, appRunner: 'gog' }),
    ...(isWindows
      ? {}
      : setupEnvVars(gameConfig, gameInfo.install.install_path))
  }

  const wrappers = setupWrappers(
    gameConfig,
    mangoHudCommand,
    gameModeBin,
    gameScopeCommand,
    steamRuntime?.length ? [...steamRuntime] : undefined
  )

  let wineFlag: string[] = wrappers.length
    ? ['--wrapper', shlex.join(wrappers)]
    : []

  if (!isNative(appName)) {
    const {
      success: wineLaunchPrepSuccess,
      failureReason: wineLaunchPrepFailReason,
      envVars: wineEnvVars
    } = await prepareWineLaunch('gog', appName)
    if (!wineLaunchPrepSuccess) {
      appendGameLog(gameInfo, `Launch aborted: ${wineLaunchPrepFailReason}`)
      if (wineLaunchPrepFailReason) {
        showDialogBoxModalAuto({
          title: t('box.error.launchAborted', 'Launch aborted'),
          message: wineLaunchPrepFailReason!,
          type: 'ERROR'
        })
      }
      return false
    }

    commandEnv = {
      ...commandEnv,
      ...wineEnvVars
    }

    const { bin: wineExec, type: wineType } = gameConfig.wineVersion

    // Fix for people with old config
    const wineBin =
      wineExec.startsWith("'") && wineExec.endsWith("'")
        ? wineExec.replaceAll("'", '')
        : wineExec

    wineFlag = getWineFlagsArray(wineBin, wineType, shlex.join(wrappers))
  }

  const commandParts = [
    'launch',
    gameInfo.install.install_path,
    ...exeOverrideFlag,
    gameInfo.app_name === '1423049311' &&
    gameInfo.install.cyberpunk?.modsEnabled
      ? '1597316373'
      : gameInfo.app_name,
    ...wineFlag,
    '--platform',
    gameInfo.install.platform.toLowerCase(),
    ...shlex.split(
      (launchArguments as BaseLaunchOption | undefined)?.parameters ?? ''
    ),
    ...shlex.split(gameConfig.launcherArgs ?? '')
  ]

  if (gameInfo.install.cyberpunk?.modsEnabled) {
    const startFolder = join(
      gameInfo.install.install_path,
      'tools',
      'redmod',
      'bin'
    )

    if (existsSync(startFolder)) {
      const installDirectory = isWindows
        ? gameInfo.install.install_path
        : await getWinePath(gameInfo.install.install_path, gameConfig, 'win')

      const availableMods = await getCyberpunkMods()
      const modsEnabledToLoad = gameInfo.install.cyberpunk.modsToLoad
      const modsAbleToLoad: string[] = []

      for (const mod of modsEnabledToLoad) {
        if (availableMods.includes(mod)) {
          modsAbleToLoad.push(mod)
        }
      }

      if (!modsEnabledToLoad.length && !!availableMods.length) {
        logWarning('No mods selected to load, loading all in alphabetic order')
        modsAbleToLoad.push(...availableMods)
      }

      const redModCommand = [
        'redMod.exe',
        'deploy',
        '-reportProgress',
        '-root',
        installDirectory,
        ...modsAbleToLoad.map((mod) => ['-mod', mod]).flat()
      ]

      let result: { stdout: string; stderr: string; code?: number | null } = {
        stdout: '',
        stderr: ''
      }
      if (isWindows) {
        const [bin, ...args] = redModCommand
        result = await spawnAsync(bin, args, { cwd: startFolder })
      } else {
        result = await runWineCommandUtil({
          commandParts: redModCommand,
          wait: true,
          gameConfig,
          gameInstallPath: gameInfo.install.install_path,
          startFolder
        })
      }
      logInfo(result.stdout, { prefix: LogPrefix.Gog })
      appendFileSync(
        logFileLocation(appName),
        `\nMods deploy log:\n${result.stdout}\n\n${result.stderr}\n\n\n`
      )
      if (result.stderr.includes('deploy has succeeded')) {
        showDialogBoxModalAuto({
          title: 'Mod deploy failed',
          message: `Following logs are also available in game log\n\nredMod log:\n ${result.stdout}\n\n\n${result.stderr}`,
          type: 'ERROR'
        })
        return true
      }
      commandParts.push('--prefer-task', '0')
    } else {
      logError(['Unable to start modded game'], { prefix: LogPrefix.Gog })
    }
  }

  const fullCommand = getRunnerCallWithoutCredentials(
    commandParts,
    commandEnv,
    join(...Object.values(getGOGdlBin()))
  )
  appendGameLog(gameInfo, `Launch Command: ${fullCommand}\n\nGame Log:\n`)

  sendGameStatusUpdate({ appName, runner: 'gog', status: 'playing' })

  sendGameStatusUpdate({
    appName,
    runner: 'gog',
    status: 'playing'
  })

  const { error, abort } = await runGogdlCommand(commandParts, {
    abortId: appName,
    env: commandEnv,
    wrappers,
    logMessagePrefix: `Launching ${gameInfo.title}`,
    onOutput: (output: string) => {
      if (!logsDisabled) appendGameLog(gameInfo, output)
    }
  })

  if (abort) {
    return true
  }

  if (error) {
    logError(['Error launching game:', error], LogPrefix.Gog)
  }

  launchCleanup(rpcClient)

  return !error
}

export async function moveInstall(
  appName: string,
  newInstallPath: string
): Promise<{ status: 'done' } | { status: 'error'; error: string }> {
  const gameInfo = getGameInfo(appName)
  const gameConfig = getGameConfig(appName, 'gog')
  logInfo(`Moving ${gameInfo.title} to ${newInstallPath}`, LogPrefix.Gog)

  const moveImpl = isWindows ? moveOnWindows : moveOnUnix
  const moveResult = await moveImpl(newInstallPath, gameInfo)

  if (moveResult.status === 'error') {
    const { error } = moveResult
    logError(
      ['Error moving', gameInfo.title, 'to', newInstallPath, error],
      LogPrefix.Gog
    )

    return { status: 'error', error }
  }

  await changeGameInstallPath(appName, moveResult.installPath)
  if (
    gameInfo.install.platform === 'windows' &&
    (isWindows || existsSync(gameConfig.winePrefix))
  ) {
    await setup(appName, undefined, false)
  }
  return { status: 'done' }
}

/*
 * This proces verifies and repairs game files
 * verification step doesn't have progress, but download does
 */
export async function repair(appName: string): Promise<ExecResult> {
  const { installPlatform, gameData, credentials, withDlcs, logPath, workers } =
    await getCommandParameters(appName)

  if (!credentials) {
    return { stderr: 'Unable to repair game, no credentials', stdout: '' }
  }
  const privateBranchPassword = privateBranchesStore.get(appName, '')

  // Most of the data provided here is discarded and read from manifest instead
  const commandParts = [
    'repair',
    appName,
    '--platform',
    installPlatform!,
    '--path',
    gameData.install.install_path!,
    '--support',
    join(gogSupportPath, appName),
    withDlcs,
    '--lang',
    gameData.install.language || 'en-US',
    '-b=' + gameData.install.buildId,
    ...workers
  ]

  if (privateBranchPassword.length) {
    commandParts.push('--password', privateBranchPassword)
  }

  const res = await runGogdlCommand(commandParts, {
    abortId: appName,
    logFile: logPath,
    logMessagePrefix: `Repairing ${appName}`
  })

  if (res.error) {
    logError(['Failed to repair', `${appName}:`, res.error], LogPrefix.Gog)
  }

  return res
}

export async function syncSaves(
  appName: string,
  arg: string,
  paths: KeyValuePair[] | null
): Promise<string> {
  if (!paths) {
    return 'Unable to sync saves, gogSaves is undefined'
  }

  const credentials = await GOGUser.getCredentials()
  if (!credentials) {
    return 'Unable to sync saves, no credentials'
  }

  const gameInfo = getGogLibraryGameInfo(appName)
  if (!gameInfo || !gameInfo.install.platform) {
    return 'Unable to sync saves, game info not found'
  }

  let fullOutput = ''

  for (const location of paths) {
    const commandParts = [
      'save-sync',
      location.value,
      appName,
      '--os',
      gameInfo.install.platform,
      '--ts',
      syncStore.get(`${appName}.${location.key}`, '0'),
      '--name',
      location.key,
      arg
    ]

    logInfo([`Syncing saves for ${gameInfo.title}`], LogPrefix.Gog)

    const res = await runGogdlCommand(commandParts, {
      abortId: appName,
      logMessagePrefix: `Syncing saves for ${gameInfo.title}`,
      onOutput: (output) => (fullOutput += output)
    })

    if (res.error) {
      logError(
        ['Failed to sync saves for', `${appName}`, `${res.error}`],
        LogPrefix.Gog
      )
    }
    if (res.stdout) {
      syncStore.set(`${appName}.${location.key}`, res.stdout.trim())
    }
  }

  return fullOutput
}

export async function uninstall({
  appName,
  shouldRemovePrefix
}: RemoveArgs): Promise<ExecResult> {
  const array = installedGamesStore.get('installed', [])
  const index = array.findIndex((game) => game.appName === appName)
  if (index === -1) {
    throw Error("Game isn't installed")
  }

  const [object] = array.splice(index, 1)
  logInfo(['Removing', object.install_path], LogPrefix.Gog)
  // Run unins000.exe /verysilent /dir=Z:/path/to/game
  const uninstallerPath = join(object.install_path, 'unins000.exe')

  const res: ExecResult = { stdout: '', stderr: '' }
  if (existsSync(uninstallerPath)) {
    const gameConfig = getGameConfig(appName, 'gog')

    const installDirectory = isWindows
      ? object.install_path
      : await getWinePath(object.install_path, gameConfig)

    const command = [
      uninstallerPath,
      '/VERYSILENT',
      `/ProductId=${appName}`,
      '/galaxyclient',
      '/KEEPSAVES'
    ]

    logInfo(['Executing uninstall command', command.join(' ')], LogPrefix.Gog)

    if (!isWindows) {
      if (existsSync(gameConfig.winePrefix) && !shouldRemovePrefix) {
        await runWineCommandUtil({
          gameConfig,
          commandParts: command,
          wait: true
        })
      }
    } else {
      const adminCommand = [
        'Start-Process',
        '-FilePath',
        uninstallerPath,
        '-Verb',
        'RunAs',
        '-Wait',
        '-ArgumentList'
      ]

      await spawnAsync('powershell', [
        ...adminCommand,
        `"/verysilent","\`"/dir=${installDirectory}\`""`,
        ``
      ])
    }
  }
  if (existsSync(object.install_path)) {
    rmSync(object.install_path, { recursive: true })
  }
  const manifestPath = join(gogdlConfigPath, 'manifests', appName)
  if (existsSync(manifestPath)) {
    rmSync(manifestPath) // Delete manifest so gogdl won't try to patch the not installed game
  }
  const supportPath = join(gogSupportPath, appName)
  if (existsSync(supportPath)) {
    rmSync(supportPath, { recursive: true }) // Remove unnecessary support dir
  }
  installedGamesStore.set('installed', array)
  refreshInstalled()
  const gameInfo = getGameInfo(appName)
  gameInfo.is_installed = false
  gameInfo.install = { is_dlc: false }
  await removeShortcutsUtil(gameInfo)
  syncStore.delete(appName)
  await removeNonSteamGame({ gameInfo })
  sendFrontendMessage('pushGameToLibrary', gameInfo)
  return res
}

export async function update(
  appName: string,
  updateOverwrites?: {
    build?: string
    branch?: string
    language?: string
    dlcs?: string[]
    dependencies?: string[]
  }
): Promise<{ status: 'done' | 'error' }> {
  if (appName === 'gog-redist') {
    const redist = await getRequiredRedistList()
    if (updateOverwrites?.dependencies?.length) {
      for (const dep of updateOverwrites.dependencies) {
        if (!redist.includes(dep)) {
          redist.push(dep)
        }
      }
    }
    return updateRedist(redist)
  }
  const {
    installPlatform,
    gameData,
    credentials,
    withDlcs,
    logPath,
    workers,
    dlcs,
    branch
  } = await getCommandParameters(appName)
  if (!installPlatform || !credentials) {
    return { status: 'error' }
  }

  const gameConfig = getGameConfig(appName, 'gog')
  const installedDlcs = gameData.install.installedDLCs || []

  if (updateOverwrites?.dlcs) {
    const removedDlcs = installedDlcs.filter(
      (dlc) => !updateOverwrites.dlcs?.includes(dlc)
    )
    if (
      removedDlcs.length &&
      gameData.install.platform === 'windows' &&
      (isWindows || existsSync(gameConfig.winePrefix))
    ) {
      // Run uninstaller per DLC
      // Find uninstallers of dlcs we are looking for first
      const listOfFiles = await readdir(gameData.install.install_path!)
      const uninstallerIniList = listOfFiles.filter((file) =>
        file.match(/unins\d{3}\.ini/)
      )

      for (const uninstallerFile of uninstallerIniList) {
        // Parse ini and find all uninstallers we need
        const rawData = await readFile(
          join(gameData.install.install_path!, uninstallerFile),
          { encoding: 'utf8' }
        )
        const parsedData = ini.parse(rawData)
        const productId = parsedData['InstallSettings']['productID']
        if (removedDlcs.includes(productId)) {
          // Run uninstall on DLC
          const uninstallExeFile = uninstallerFile.replace('ini', 'exe')
          if (isWindows) {
            const adminCommand = [
              'Start-Process',
              '-FilePath',
              uninstallExeFile,
              '-Verb',
              'RunAs',
              '-Wait',
              '-ArgumentList'
            ]
            await spawnAsync(
              'powershell',
              [
                ...adminCommand,
                `"/ProductId=${productId}","/VERYSILENT","/galaxyclient","/KEEPSAVES"`
              ],
              { cwd: gameData.install.install_path }
            )
          } else {
            await runWineCommand({
              gameConfig,
              protonVerb: 'run',
              commandParts: [
                uninstallExeFile,
                `/ProductId=${productId}`,
                '/VERYSILENT',
                '/galaxyclient',
                '/KEEPSAVES'
              ],
              startFolder: gameData.install.install_path!
            })
          }
        }
      }
    }
  }

  const privateBranchPassword = privateBranchesStore.get(appName, '')

  const overwrittenBuild: string[] = updateOverwrites?.build
    ? ['--build', updateOverwrites.build]
    : []

  const overwrittenBranch: string[] = updateOverwrites?.branch
    ? ['--branch', updateOverwrites.branch]
    : branch

  const overwrittenLanguage: string =
    updateOverwrites?.language || gameData.install.language || 'en-US'

  const overwrittenDlcs: string[] = updateOverwrites?.dlcs?.length
    ? ['--dlcs', updateOverwrites.dlcs.join(',')]
    : dlcs

  const overwrittenWithDlcs: string = updateOverwrites?.dlcs
    ? updateOverwrites.dlcs.length
      ? '--with-dlcs'
      : '--skip-dlcs'
    : withDlcs

  const commandParts = [
    'update',
    appName,
    '--platform',
    installPlatform,
    '--path',
    gameData.install.install_path!,
    '--support',
    join(gogSupportPath, appName),
    overwrittenWithDlcs,
    '--lang',
    overwrittenLanguage,
    ...overwrittenDlcs,
    ...workers,
    ...overwrittenBuild,
    ...overwrittenBranch
  ]
  if (privateBranchPassword.length) {
    commandParts.push('--password', privateBranchPassword)
  }

  const onOutput = (data: string) => {
    onInstallOrUpdateOutput(appName, 'updating', data)
  }

  const res = await runGogdlCommand(commandParts, {
    abortId: appName,
    logFile: logPath,
    onOutput,
    logMessagePrefix: `Updating ${appName}`
  })

  if (res.abort) {
    return { status: 'done' }
  }

  if (res.error) {
    logError(['Failed to update', `${appName}:`, res.error], LogPrefix.Gog)
    sendGameStatusUpdate({
      appName: appName,
      runner: 'gog',
      status: 'done'
    })
    return { status: 'error' }
  }

  const installedArray = installedGamesStore.get('installed', [])
  const gameIndex = installedArray.findIndex(
    (value) => appName === value.appName
  )
  const gameObject = installedArray[gameIndex]

  if (gameData.install.platform !== 'linux') {
    const installInfo = await getInstallInfo(
      appName,
      gameData.install.platform ?? 'windows',
      updateOverwrites?.branch,
      updateOverwrites?.build
    )
    // TODO: use installInfo.game.builds
    const { etag } = await getMetaResponse(
      appName,
      gameData.install.platform ?? 'windows',
      installInfo?.manifest.versionEtag
    )
    if (installInfo === undefined) return { status: 'error' }
    gameObject.buildId = installInfo.game.buildId
    gameObject.version = installInfo.game.version
    gameObject.branch = updateOverwrites?.branch
    gameObject.language = overwrittenLanguage
    if (updateOverwrites?.dlcs) {
      gameObject.installedDLCs = updateOverwrites?.dlcs
    }
    gameObject.versionEtag = etag
  } else {
    const installerInfo = await getLinuxInstallerInfo(appName)
    if (!installerInfo) {
      return { status: 'error' }
    }
    gameObject.version = installerInfo.version
  }
  const sizeOnDisk = await getPathDiskSize(join(gameObject.install_path))
  gameObject.install_size = getFileSize(sizeOnDisk)
  installedGamesStore.set('installed', installedArray)
  refreshInstalled()
  // Simple check if wine prefix exists and setup can be performed because of an
  // update
  if (
    gameObject.platform === 'windows' &&
    (isWindows || existsSync(gameConfig.winePrefix))
  ) {
    await setup(appName, gameObject, false)
  }
  sendGameStatusUpdate({
    appName: appName,
    runner: 'gog',
    status: 'done'
  })
  gameData.install = gameObject
  sendFrontendMessage('pushGameToLibrary', gameData)
  return { status: 'done' }
}

/**
 * Reads game installed data and returns proper parameters
 * Useful for Update and Repair
 */
async function getCommandParameters(appName: string) {
  const { maxDownloadWorkers } = getGlobalConfig()
  const workers = maxDownloadWorkers
    ? ['--max-workers', `${maxDownloadWorkers}`]
    : []
  const gameData = getGameInfo(appName)
  const logPath = logFileLocation(appName)
  const credentials = await GOGUser.getCredentials()

  const numberOfDLCs = gameData.install?.installedDLCs?.length || 0

  const withDlcs =
    gameData.install.installedWithDLCs || numberOfDLCs > 0
      ? '--with-dlcs'
      : '--skip-dlcs'

  const dlcs =
    gameData.install.installedDLCs && numberOfDLCs > 0
      ? ['--dlcs', gameData.install.installedDLCs.join(',')]
      : []

  const branch = gameData.install.branch
    ? ['--branch', gameData.install.branch]
    : []

  const installPlatform = gameData.install.platform

  return {
    withDlcs,
    workers,
    installPlatform,
    logPath,
    credentials,
    gameData,
    dlcs,
    branch
  }
}

export async function forceUninstall(appName: string): Promise<void> {
  const installed = installedGamesStore.get('installed', [])
  const newInstalled = installed.filter((g) => g.appName !== appName)
  installedGamesStore.set('installed', newInstalled)
  refreshInstalled()
  sendFrontendMessage('pushGameToLibrary', getGameInfo(appName))
}

// GOGDL now handles the signal, this is no longer needed
export async function stop(appName: string, stopWine = true): Promise<void> {
  if (stopWine && !isNative(appName)) {
    const gameConfig = getGameConfig(appName, 'gog')
    await shutdownWine(gameConfig)
  }
}

export async function isGameAvailable(appName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const info = getGameInfo(appName)
    if (info && info.is_installed) {
      if (info.install.install_path && existsSync(info.install.install_path!)) {
        resolve(true)
      } else {
        resolve(false)
      }
    }
    resolve(false)
  })
}

async function postPlaytimeSession({
  appName,
  session_date,
  time
}: GOGSessionSyncQueueItem) {
  const userData: UserData | undefined = configStore.get_nodefault('userData')
  if (!userData) {
    logError('No userData, unable to post new session', {
      prefix: LogPrefix.Gog
    })
    return null
  }
  const credentials = await GOGUser.getCredentials().catch(() => null)

  if (!credentials) {
    logError("Couldn't fetch credentials, unable to post new session", {
      prefix: LogPrefix.Gog
    })
    return null
  }

  return axios
    .post(
      `https://gameplay.gog.com/games/${appName}/users/${userData?.galaxyUserId}/sessions`,
      { session_date, time },
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`
        }
      }
    )
    .catch((e: AxiosError) => {
      logDebug(['Failed to post session', e.toJSON()], {
        prefix: LogPrefix.Gog
      })
      return null
    })
}

export async function updateGOGPlaytime(
  appName: string,
  startPlayingDate: Date,
  finishedPlayingDate: Date
) {
  // Let server know about new session
  const sessionDate = Math.floor(startPlayingDate.getTime() / 1000) // In seconds
  const time = Math.floor(
    (finishedPlayingDate.getTime() - startPlayingDate.getTime()) / 1000 / 60
  ) // In minutes

  // It makes no sense to post 0 minutes of playtime
  if (time < 1) {
    return
  }

  const data = {
    session_date: sessionDate,
    time
  }
  const userData: UserData | undefined = configStore.get_nodefault('userData')

  if (!userData) {
    logWarning(['Unable to post session, userData not present'], {
      prefix: LogPrefix.Gog
    })
    return
  }

  if (!isOnline()) {
    logWarning(['App offline, unable to post new session at this time'], {
      prefix: LogPrefix.Gog
    })
    const alreadySetData = playtimeSyncQueue.get(userData.galaxyUserId, [])
    alreadySetData.push({ ...data, appName })
    playtimeSyncQueue.set(userData.galaxyUserId, alreadySetData)
    runOnceWhenOnline(syncQueuedPlaytimeGOG)
    return
  }

  const response = await postPlaytimeSession({ ...data, appName }).catch(
    () => null
  )

  if (!response || response.status !== 201) {
    logError('Failed to post session', { prefix: LogPrefix.Gog })
    const alreadySetData = playtimeSyncQueue.get(userData.galaxyUserId, [])
    alreadySetData.push({ ...data, appName })
    playtimeSyncQueue.set(userData.galaxyUserId, alreadySetData)
    return
  }

  logInfo('Posted session to gameplay.gog.com', { prefix: LogPrefix.Gog })
}

export async function syncQueuedPlaytimeGOG() {
  if (playtimeSyncQueue.has('lock')) {
    return
  }
  const userData: UserData | undefined = configStore.get_nodefault('userData')
  if (!userData) {
    logError('Unable to syncQueued playtime, userData not present', {
      prefix: LogPrefix.Gog
    })
    return
  }
  const queue = playtimeSyncQueue.get(userData.galaxyUserId, [])
  if (queue.length === 0) {
    return
  }
  playtimeSyncQueue.set('lock', [])
  const failed = []

  for (const session of queue) {
    if (!isOnline()) {
      failed.push(session)
    }
    const response = await postPlaytimeSession(session)

    if (!response || response.status !== 201) {
      logError('Failed to post session', { prefix: LogPrefix.Gog })
      failed.push(session)
    }
  }
  playtimeSyncQueue.set(userData.galaxyUserId, failed)
  playtimeSyncQueue.delete('lock')
  logInfo(
    ['Finished posting sessions to gameplay.gog.com', 'failed:', failed.length],
    {
      prefix: LogPrefix.Gog
    }
  )
}

export async function getGOGPlaytime(
  appName: string
): Promise<number | undefined> {
  if (!isOnline()) {
    return
  }
  const credentials = await GOGUser.getCredentials()
  const userData: UserData | undefined = configStore.get_nodefault('userData')

  if (!credentials || !userData) {
    return
  }
  const response = await axios
    .get(
      `https://gameplay.gog.com/games/${appName}/users/${userData?.galaxyUserId}/sessions`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`
        }
      }
    )
    .catch((e: AxiosError) => {
      logWarning(['Failed attempt to get playtime of', appName, e.toJSON()], {
        prefix: LogPrefix.Gog
      })
      return null
    })

  return response?.data?.time_sum
}

export function getBranchPassword(appName: string): string {
  return privateBranchesStore.get(appName, '')
}

export function setBranchPassword(appName: string, password: string): void {
  privateBranchesStore.set(appName, password)
}

export async function getCyberpunkMods(): Promise<string[]> {
  const gameInfo = getGogLibraryGameInfo('1423049311')
  if (!gameInfo || !gameInfo?.install?.install_path) {
    return []
  }

  const modsPath = join(gameInfo.install.install_path, 'mods')
  if (!existsSync(modsPath)) {
    return []
  }
  const modsPathContents = await readdir(modsPath)

  return modsPathContents.reduce((acc, next) => {
    const modPath = join(modsPath, next)
    const infoFilePath = join(modPath, 'info.json')

    const modStat = statSync(modPath)

    if (modStat.isDirectory() && existsSync(infoFilePath)) {
      acc.push(next)
    }

    return acc
  }, [] as string[])
}
