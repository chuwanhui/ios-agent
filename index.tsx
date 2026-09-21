import { Navigation, Script } from "scripting"
import { ChatPage } from "./chat_page"

async function run() {
  await Navigation.present({ element: <ChatPage /> })
  Script.exit()
}

run()
