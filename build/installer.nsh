!macro customInit
  ; Try graceful close first so pending writes can flush.
  nsExec::Exec 'taskkill /IM Merlin.exe /T'
  Pop $0
  ; Force-close if still running (ignore errors when app is not running).
  nsExec::Exec 'taskkill /F /IM Merlin.exe /T'
  Pop $0
!macroend

!macro customInstall
  ; Skip auto-launch for silent installs (CI/managed deployment).
  IfSilent done

  ; Primary path: launch detached via Task Scheduler to avoid installer file locks.
  nsExec::Exec 'schtasks /Create /TN MerlinLaunch /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\"" /SC ONCE /ST 00:00 /F'
  Pop $0
  StrCmp $0 "0" 0 launch_fallback

  nsExec::Exec 'schtasks /Run /TN MerlinLaunch'
  Pop $0
  StrCmp $0 "0" 0 launch_fallback

  ; Give Task Scheduler a moment to hand off before deleting the task definition.
  Sleep 1000
  nsExec::Exec 'schtasks /Delete /TN MerlinLaunch /F'
  Pop $0
  Goto done

launch_fallback:
  ; Fallback for systems where Task Scheduler is disabled by policy.
  nsExec::Exec 'schtasks /Delete /TN MerlinLaunch /F'
  Pop $0
  ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""

done:
!macroend
