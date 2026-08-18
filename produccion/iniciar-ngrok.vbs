Set sh = CreateObject("WScript.Shell")
sh.Run "ngrok http --url=https://daunting-feel-tackiness.ngrok-free.dev 4000", 0, False
