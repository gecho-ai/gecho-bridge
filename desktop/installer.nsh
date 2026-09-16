!macro customInit
  ; 安装启动前强制关闭所有可能占用的 Gecho 相关进程
  nsExec::Exec 'taskkill /F /T /IM Gecho.exe'
  Sleep 1000
!macroend

!macro customUnInit
  ; 卸载前同样强制关闭所有 Gecho 相关进程
  nsExec::Exec 'taskkill /F /T /IM Gecho.exe'
  Sleep 1000
!macroend

!macro customCheckAppRunning
  ; 替换原版检测与阻塞弹窗：直接静默杀掉所有运行实例与子进程树，绝不弹窗阻塞用户
  DetailPrint "Closing running instances of Gecho..."
  nsExec::Exec 'taskkill /F /T /IM Gecho.exe'
  Sleep 1000
!macroend
