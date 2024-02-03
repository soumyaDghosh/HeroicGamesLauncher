import {
  ExtraInfo,
  GameInfo,
  InstallPlatform,
  ExecResult,
  InstallArgs,
  InstallInfo,
  LaunchOption
} from 'common/types'
import type { KeyValuePair } from 'backend/schemas'
import { GOGCloudSavesLocation } from './gog'

export interface InstallResult {
  status: 'done' | 'error' | 'abort'
  error?: string
}

export type RemoveArgs = {
  appName: string
  shouldRemovePrefix?: boolean
  deleteFiles?: boolean
}

export interface GameManager {
  getGameInfo: (appName: string) => GameInfo
  getExtraInfo: (appName: string) => Promise<ExtraInfo>
  importGame: (
    appName: string,
    path: string,
    platform: InstallPlatform
  ) => Promise<ExecResult>
  onInstallOrUpdateOutput: (
    appName: string,
    action: 'installing' | 'updating',
    data: string,
    totalDownloadSize: number
  ) => void
  install: (appName: string, args: InstallArgs) => Promise<InstallResult>
  isNative: (appName: string) => boolean
  addShortcuts: (appName: string, fromMenu?: boolean) => Promise<void>
  removeShortcuts: (appName: string) => Promise<void>
  launch: (
    appName: string,
    launchArguments?: LaunchOption,
    skipVersionCheck?: boolean
  ) => Promise<boolean>
  moveInstall: (
    appName: string,
    newInstallPath: string
  ) => Promise<InstallResult>
  repair: (appName: string) => Promise<ExecResult>
  syncSaves: (
    appName: string,
    arg: string,
    paths: KeyValuePair[] | null,
    gogSaves?: GOGCloudSavesLocation[]
  ) => Promise<string>
  uninstall: (args: RemoveArgs) => Promise<ExecResult>
  update: (
    appName: string,
    updateOverwrites?: {
      build?: string
      branch?: string
      language?: string
      dlcs?: string[]
      dependencies?: string[]
    }
  ) => Promise<InstallResult>
  forceUninstall: (appName: string) => Promise<void>
  stop: (appName: string, stopWine?: boolean) => Promise<void>
  isGameAvailable: (appName: string) => Promise<boolean>
}

export interface LibraryManager {
  refresh: () => Promise<ExecResult | null>
  getGameInfo: (appName: string, forceReload?: boolean) => GameInfo | undefined
  getInstallInfo: (
    appName: string,
    installPlatform: InstallPlatform,
    branch?: string,
    build?: string
  ) => Promise<InstallInfo | undefined>
  listUpdateableGames: () => Promise<string[]>
  changeGameInstallPath: (appName: string, newPath: string) => Promise<void>
  changeVersionPinnedStatus: (appName: string, status: boolean) => void
  installState: (appName: string, state: boolean) => void
  getLaunchOptions: (
    appName: string
  ) => LaunchOption[] | Promise<LaunchOption[]>
}
