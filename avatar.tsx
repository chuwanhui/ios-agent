import { Image, VStack } from "scripting"

/**
 * 角色头像：一张照片。
 *  - 上传过照片 → 渲染 appGroup 里的那张图（`path`）；
 *  - 没上传 / 文件没了 → 灰圆底 + 人形占位图（不再有 emoji 头像）。
 *
 * 为什么存 appGroup：只有 `appGroupDocumentsDirectory` 里的文件能被 Widget 读到，
 * 而且它不会同步到 iCloud。
 */
export interface AvatarSpec {
  /** 自定义头像图片的绝对路径；为空或文件不存在时显示占位图。 */
  path?: string
}

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
 * 从相册选一张照片（唯一的头像来源）。图片先落到暂存路径，点「保存」时才转正。
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

// ———————————————————————— 视图 ————————————————————————

interface Props {
  spec: AvatarSpec
  /** 圆形直径，默认 34。 */
  size?: number
  /** 占位圆的底色。 */
  background?: "secondarySystemFill" | "tertiarySystemFill"
  onTapGesture?: () => void
}

/** 圆形头像：有照片就显示照片，否则显示人形占位图。 */
export function Avatar({
  spec,
  size = 34,
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
  // 占位图：字号跟着直径走，太大就整体放大一点
  const glyph = size >= 70 ? "largeTitle" : size >= 50 ? "title2" : size >= 42 ? "title3" : "callout"
  return (
    <VStack
      frame={{ width: size, height: size }}
      background={background}
      clipShape="circle"
      onTapGesture={onTapGesture}
    >
      <Image systemName="person.fill" font={glyph} foregroundStyle="secondaryLabel" />
    </VStack>
  )
}
