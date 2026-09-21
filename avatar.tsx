import { Image, Text, VStack } from "scripting"

/**
 * 角色头像。两种形态：
 *  - 没上传照片 → 一个圆形里的 emoji（`emoji`）；
 *  - 上传了照片 → 渲染 appGroup 里的那张图（`path`），文件不见了自动退回 emoji。
 *
 * 为什么存 appGroup：只有 `appGroupDocumentsDirectory` 里的文件能被 Widget / 灵动岛读到，
 * 而且它不会同步到 iCloud。
 */
export interface AvatarSpec {
  emoji: string
  /** 自定义头像图片的绝对路径；为空或文件不存在时用 emoji。 */
  path?: string
}

/** emoji 头像用的字号（`Font` 关键字的子集）。 */
export type AvatarFont =
  | "largeTitle"
  | "title"
  | "title2"
  | "title3"
  | "headline"
  | "subheadline"
  | "body"
  | "callout"

/** 头像文件所在目录（与 config.json 同一层）。 */
export const AVATAR_DIR = FileManager.appGroupDocumentsDirectory + "/agent"
/** 正式头像文件（覆盖式更新，只留一张）。 */
export const AVATAR_PATH = AVATAR_DIR + "/avatar.png"
/** 设置页里「选了但还没点保存」时的暂存文件。 */
export const PENDING_AVATAR_PATH = AVATAR_DIR + "/avatar-pending.png"
/** 存盘边长：512pt 够用，文件也小（原图可能十几 MB）。 */
const AVATAR_SIDE = 512

function fileExists(path?: string): boolean {
  if (!path) return false
  try {
    return FileManager.existsSync(path)
  } catch {
    return false
  }
}

// ———————————————————————— 落盘 ————————————————————————

/**
 * 把一张图居中裁成正方形、缩到 512pt、转成 PNG 写进 `dest`。
 * 返回写入的路径；失败返回 null。
 */
export function saveAvatarImage(img: UIImage, dest: string = PENDING_AVATAR_PATH): string | null {
  try {
    const w = img.width
    const h = img.height
    if (!(w > 0 && h > 0)) return null
    const side = Math.min(w, h)
    const square =
      img.renderedIn(
        { width: AVATAR_SIDE, height: AVATAR_SIDE },
        { position: { x: (w - side) / 2, y: (h - side) / 2 }, size: { width: side, height: side } },
      ) ?? img
    const data = square.toPNGData() ?? img.toPNGData()
    if (!data) return null
    FileManager.createDirectorySync(AVATAR_DIR, true)
    FileManager.writeAsDataSync(dest, data)
    return fileExists(dest) ? dest : null
  } catch {
    return null
  }
}

/**
 * 从相册选一张照片。图片先落到暂存路径，点「保存」时才转正。
 * 用户取消选择时返回 null（读取失败会抛错，交给调用方提示）。
 */
export async function chooseAvatarFromPhotos(
  dest: string = PENDING_AVATAR_PATH,
): Promise<string | null> {
  const picked = await Photos.pick({ filter: PHPickerFilter.images(), limit: 1 })
  const first = picked && picked[0]
  if (!first) return null
  let img: UIImage | null = null
  try {
    img = await first.uiImage()
  } catch {
    img = null
  }
  if (!img) {
    // 退路：拿到沙箱里的图片文件（用完自己删）
    try {
      const path = await first.imagePath()
      if (path) {
        img = UIImage.fromFile(path)
        try {
          FileManager.removeSync(path)
        } catch {
          // 删不掉也无所谓，在 appGroup 临时目录里
        }
      }
    } catch {
      img = null
    }
  }
  return img ? saveAvatarImage(img, dest) : null
}

/** 用相机拍一张当头像（前置、可裁剪）。取消时返回 null。 */
export async function captureAvatarPhoto(
  dest: string = PENDING_AVATAR_PATH,
): Promise<string | null> {
  const info = await Photos.capture({
    mode: "photo",
    mediaTypes: ["public.image"],
    allowsEditing: true,
    cameraDevice: "front",
    cameraFlashMode: "off",
  })
  if (!info) return null
  const img = info.editedImage ?? info.originalImage ?? (info.imagePath ? UIImage.fromFile(info.imagePath) : null)
  if (info.imagePath) {
    try {
      FileManager.removeSync(info.imagePath)
    } catch {
      // 忽略
    }
  }
  return img ? saveAvatarImage(img, dest) : null
}

/** 暂存头像转正（点「保存」时调用）。返回是否成功。 */
export function commitAvatar(): boolean {
  try {
    if (!fileExists(PENDING_AVATAR_PATH)) return false
    if (fileExists(AVATAR_PATH)) FileManager.removeSync(AVATAR_PATH)
    FileManager.renameSync(PENDING_AVATAR_PATH, AVATAR_PATH)
    return fileExists(AVATAR_PATH)
  } catch {
    return false
  }
}

/** 丢掉暂存头像（点「取消」时调用）。 */
export function discardAvatar(): void {
  try {
    if (fileExists(PENDING_AVATAR_PATH)) FileManager.removeSync(PENDING_AVATAR_PATH)
  } catch {
    // 忽略
  }
}

/** 删除正式头像文件（恢复 emoji）。 */
export function removeAvatarFile(): void {
  try {
    if (fileExists(AVATAR_PATH)) FileManager.removeSync(AVATAR_PATH)
  } catch {
    // 忽略
  }
}

// ———————————————————————— 视图 ————————————————————————

interface Props {
  spec: AvatarSpec
  /** 圆形直径，默认 34。 */
  size?: number
  /** emoji 字号；默认按 size 猜：> 44 用 largeTitle，否则 callout。 */
  font?: AvatarFont
  /** 圆底颜色。 */
  background?: "secondarySystemFill" | "tertiarySystemFill"
  onTapGesture?: () => void
}

/** 圆形头像：有照片就显示照片，否则显示 emoji。 */
export function Avatar({
  spec,
  size = 34,
  font,
  background = "secondarySystemFill",
  onTapGesture,
}: Props) {
  const path = fileExists(spec.path) ? (spec.path as string) : ""
  if (path) {
    return (
      <Image
        filePath={path}
        resizable
        frame={{ width: size, height: size }}
        clipShape="circle"
        onTapGesture={onTapGesture}
      />
    )
  }
  const emojiFont: AvatarFont = font ?? (size > 44 ? "largeTitle" : "callout")
  return (
    <VStack
      frame={{ width: size, height: size }}
      background={background}
      clipShape="circle"
      onTapGesture={onTapGesture}
    >
      <Text font={emojiFont} scaleEffect={size >= 100 ? 2 : 1}>
        {spec.emoji}
      </Text>
    </VStack>
  )
}
