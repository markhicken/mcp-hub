; Tauri NSIS hooks. MCP Hub is three programs: the app (mcp-hub-desktop.exe), the hub service (mcp-hub-core.exe) and the
; bridge other apps launch (mcp-hub-stdio.exe). Windows will not replace or delete a program that is running, so before
; installing or uninstalling we look for any of them, ask once, and close them if the user agrees.
; The user's data (%APPDATA%\MCP Hub) and the encryption key in Credential Manager are deliberately left alone.

!define MCPHUB_PROGRAMS "mcp-hub-desktop.exe mcp-hub-core.exe mcp-hub-stdio.exe"

!macro MCPHUB_CLOSE_RUNNING id
  nsExec::Exec 'cmd /c tasklist /NH | findstr /I "${MCPHUB_PROGRAMS}"'
  Pop $0
  ; findstr exits 0 when it found at least one of them.
  ${If} $0 = 0
    ; Silent and passive runs can't ask: close them and carry on.
    IfSilent mcphub_close_${id} 0
    ${IfThen} $PassiveMode = 1 ${|} Goto mcphub_close_${id} ${|}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "MCP Hub is running.$\n$\nClick OK to close it and continue. Apps that use MCP Hub (such as Claude) will lose their connection until MCP Hub is started again.$\n$\nClick Cancel to stop." IDOK mcphub_close_${id}
    Abort "MCP Hub is still running. Close it and try again."
    mcphub_close_${id}:
    ; /T also ends the servers the hub started.
    nsExec::Exec 'taskkill /F /T /IM mcp-hub-desktop.exe'
    Pop $0
    nsExec::Exec 'taskkill /F /T /IM mcp-hub-core.exe'
    Pop $0
    nsExec::Exec 'taskkill /F /IM mcp-hub-stdio.exe'
    Pop $0
    ; Give Windows a moment to release the files.
    Sleep 1000
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MCPHUB_CLOSE_RUNNING install
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MCPHUB_CLOSE_RUNNING uninstall
!macroend
