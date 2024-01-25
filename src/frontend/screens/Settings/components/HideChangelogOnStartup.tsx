import React from 'react'
import { ToggleSwitch } from 'frontend/components/UI'
import { useGlobalConfig } from 'frontend/hooks/config'
import { useTranslation } from 'react-i18next'

const HideChangelogOnStartup = () => {
  const { t } = useTranslation()
  const [
    hideChangelogsOnStartup,
    setHideChangelogsOnStartup,
    ,
    isSetToDefaultValue,
    resetToDefaultValue
  ] = useGlobalConfig('hideChangelogsOnStartup')

  return (
    <ToggleSwitch
      htmlId="hideChangelogsOnStartup"
      value={hideChangelogsOnStartup}
      handleChange={async () =>
        setHideChangelogsOnStartup(!hideChangelogsOnStartup)
      }
      title={t(
        'setting.hideChangelogsOnStartup',
        "Don't show changelogs on Startup"
      )}
      isSetToDefaultValue={isSetToDefaultValue}
      resetToDefaultValue={resetToDefaultValue}
    />
  )
}

export default HideChangelogOnStartup
