!macro customInit
  ; 检查并强制关闭正在运行的旧版本 Gecho 进程，避免安装或覆盖更新时文件被占用
  nsExec::Exec 'taskkill /f /im Gecho.exe'
  Sleep 500
!macroend

!macro customUnInit
  ; 卸载前同样自动关闭运行中的 Gecho 进程
  nsExec::Exec 'taskkill /f /im Gecho.exe'
  Sleep 500
!macroend
