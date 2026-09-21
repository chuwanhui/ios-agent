import { Navigation, Script } from "scripting"
import { ChatPage } from "./chat_page"

async function run() {
  // fullScreen：聊天页铺满整屏（默认的 pageSheet 会留出上下空白、像一张卡片）。
  await Navigation.present({
    element: <ChatPage />,
    modalPresentationStyle: "fullScreen",
  })
  Script.exit()
}

run()
