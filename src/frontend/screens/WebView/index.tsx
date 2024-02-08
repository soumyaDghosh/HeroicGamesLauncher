import React, {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useLocation, useParams } from 'react-router'

import { UpdateComponent } from 'frontend/components/UI'
import WebviewControls from 'frontend/components/UI/WebviewControls'
import ContextProvider from 'frontend/state/ContextProvider'
import { WebviewType } from 'common/types'
import './index.css'
import LoginWarning from '../Login/components/LoginWarning'
import { NileLoginData } from 'common/types/nile'

const validStoredUrl = (url: string, store: string) => {
  switch (store) {
    case 'epic':
      return url.includes('epicgames.com')
    case 'gog':
      return url.includes('gog.com')
    case 'amazon':
      return url.includes('gaming.amazon.com')
    default:
      return false
  }
}

export default function WebView() {
  const { i18n } = useTranslation()
  const { pathname, search } = useLocation()
  const { t } = useTranslation()
  const { epic, gog, amazon, connectivity } = useContext(ContextProvider)
  const [loading, setLoading] = useState<{
    refresh: boolean
    message: string
  }>(() => ({
    refresh: true,
    message: t('loading.website', 'Loading Website')
  }))
  const [amazonLoginData, setAmazonLoginData] = useState<NileLoginData | null>(
    null
  )
  const navigate = useNavigate()
  const webviewRef = useRef<WebviewType>(null)

  // `store` is set to epic/gog/amazon depending on which storefront we're
  // supposed to show, `runner` is set to a runner if we're supposed to show its
  // login prompt
  const { store, runner } = useParams()

  let lang = i18n.language
  if (i18n.language === 'pt') {
    lang = 'pt-BR'
  }

  const epicLoginUrl = 'https://legendary.gl/epiclogin'

  const epicStore = `https://www.epicgames.com/store/${lang}/`
  const gogStore = `https://af.gog.com?as=1838482841`
  const amazonStore = `https://gaming.amazon.com`
  const wikiURL =
    'https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/wiki'
  const gogEmbedRegExp = new RegExp('https://embed.gog.com/on_login_success?')
  const gogLoginUrl =
    'https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=galaxy'

  const trueAsStr = 'true' as unknown as boolean | undefined

  const urls: { [pathname: string]: string } = {
    '/store/epic': epicStore,
    '/store/gog': gogStore,
    '/store/amazon': amazonStore,
    '/wiki': wikiURL,
    '/loginEpic': epicLoginUrl,
    '/loginGOG': gogLoginUrl,
    '/loginweb/legendary': epicLoginUrl,
    '/loginweb/gog': gogLoginUrl,
    '/loginweb/nile': amazonLoginData ? amazonLoginData.url : ''
  }
  let startUrl = urls[pathname]

  if (store) {
    sessionStorage.setItem('last-store', store)
    const lastUrl = sessionStorage.getItem(`last-url-${store}`)
    if (lastUrl && validStoredUrl(lastUrl, store)) {
      startUrl = lastUrl
    }
  }

  if (pathname.match(/store-page/)) {
    const searchParams = new URLSearchParams(search)
    const queryParam = searchParams.get('store-url')
    if (queryParam) {
      startUrl = queryParam
    }
  }

  const isEpicLogin = runner === 'legendary' && startUrl === epicLoginUrl
  const [preloadPath, setPreloadPath] = useState('')

  useEffect(() => {
    let mounted = true
    const fetchLocalPreloadPath = async () => {
      const path = (await window.api.getLocalPeloadPath()) as unknown
      if (mounted) {
        setPreloadPath(path as string)
      }
    }

    if (isEpicLogin) {
      fetchLocalPreloadPath()
    }

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (pathname !== '/loginweb/nile') return
    console.log('Loading amazon login data')

    setLoading({
      refresh: true,
      message: t('status.preparing_login', 'Preparing Login...')
    })
    amazon.getLoginData().then((data) => {
      setAmazonLoginData(data)
      setLoading({
        ...loading,
        refresh: false
      })
    })
  }, [pathname])

  const handleAmazonLogin = (code: string) => {
    if (!amazonLoginData) {
      console.error('Could not login to Amazon because login data is missing')
      return
    }

    setLoading({
      refresh: true,
      message: t('status.logging', 'Logging In...')
    })
    amazon
      .login({
        client_id: amazonLoginData.client_id,
        code: code,
        code_verifier: amazonLoginData.code_verifier,
        serial: amazonLoginData.serial
      })
      .then(() => {
        handleSuccessfulLogin()
      })
  }

  const handleSuccessfulLogin = () => {
    navigate('/login')
  }

  useLayoutEffect(() => {
    const webview = webviewRef.current
    if (webview && ((preloadPath && isEpicLogin) || !isEpicLogin)) {
      const onIpcMessage = async (event: unknown) => {
        const e = event as { channel: string; args: string[] }
        if (e.channel === 'processEpicLoginCode') {
          try {
            setLoading({
              refresh: true,
              message: t('status.logging', 'Logging In...')
            })
            await epic.login(e.args[0])
            handleSuccessfulLogin()
          } catch (error) {
            console.error(error)
            window.api.logError(String(error))
          }
        }
      }

      webview.addEventListener('ipc-message', onIpcMessage)

      const loadstop = async () => {
        setLoading({ ...loading, refresh: false })
        // Ignore the login handling if not on login page
        if (!runner) {
          return
        } else if (runner === 'gog') {
          const pageUrl = webview.getURL()
          if (pageUrl.match(gogEmbedRegExp)) {
            const parsedURL = new URL(pageUrl)
            const code = parsedURL.searchParams.get('code')
            setLoading({
              refresh: true,
              message: t('status.logging', 'Logging In...')
            })
            if (code) {
              gog.login(code).then(() => {
                handleSuccessfulLogin()
              })
            }
          }
        } else if (runner === 'nile') {
          const pageURL = webview.getURL()
          const parsedURL = new URL(pageURL)
          const code = parsedURL.searchParams.get(
            'openid.oa2.authorization_code'
          )
          if (code) {
            handleAmazonLogin(code)
          }
        }
      }

      webview.addEventListener('dom-ready', loadstop)

      // if the page title changed it's because the store loaded so there's
      // connectivity, we can update the status without waiting for the checks
      const updateConnectivity = () => {
        if (connectivity.status !== 'online') {
          window.api.setConnectivityOnline()
        }
      }
      webview.addEventListener('page-title-updated', updateConnectivity)

      return () => {
        webview.removeEventListener('ipc-message', onIpcMessage)
        webview.removeEventListener('dom-ready', loadstop)
        webview.removeEventListener('page-title-updated', updateConnectivity)
      }
    }
    return
  }, [webviewRef.current, preloadPath, amazonLoginData])

  useEffect(() => {
    const webview = webviewRef.current
    if (webview && store) {
      const onNavigate = () => {
        const url = webview.getURL()
        if (validStoredUrl(url, store)) {
          sessionStorage.setItem(`last-url-${store}`, webview.getURL())
        }
      }

      // this one is needed for gog/amazon
      webview.addEventListener('did-navigate', onNavigate)
      // this one is needed for epic
      webview.addEventListener('did-navigate-in-page', onNavigate)

      return () => {
        webview.removeEventListener('did-navigate', onNavigate)
        webview.removeEventListener('did-navigate-in-page', onNavigate)
      }
    }

    return
  }, [webviewRef.current, store])

  const [showLoginWarningFor, setShowLoginWarningFor] = useState<
    null | 'epic' | 'gog' | 'amazon'
  >(null)

  useEffect(() => {
    if (startUrl.match(/epicgames\.com/) && !epic.username) {
      setShowLoginWarningFor('epic')
    } else if (
      startUrl.match(/gog\.com/) &&
      !startUrl.match(/auth\.gog\.com/) &&
      !gog.username
    ) {
      setShowLoginWarningFor('gog')
    } else if (startUrl.match(/gaming\.amazon\.com/) && !amazon.user_id) {
      setShowLoginWarningFor('amazon')
    }
  }, [startUrl])

  const onLoginWarningClosed = () => {
    setShowLoginWarningFor(null)
  }

  if (!preloadPath && isEpicLogin) {
    return <></>
  }

  return (
    <div className="WebView">
      {webviewRef.current && (
        <WebviewControls
          webview={webviewRef.current}
          initURL={startUrl}
          openInBrowser={!startUrl.startsWith('login')}
        />
      )}
      {loading.refresh && <UpdateComponent message={loading.message} />}
      <webview
        ref={webviewRef}
        className="WebView__webview"
        partition="persist:epicstore"
        src={startUrl}
        allowpopups={trueAsStr}
        useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/200.0"
        {...(preloadPath ? { preload: preloadPath } : {})}
      />
      {showLoginWarningFor && (
        <LoginWarning
          warnLoginForStore={showLoginWarningFor}
          onClose={onLoginWarningClosed}
        />
      )}
    </div>
  )
}
