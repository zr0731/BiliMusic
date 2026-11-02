/** 歌词条可以伸出屏幕，只要还留得住一截，才能盖到右下角的小窗上。 */
export function clampLyricBounds(x: number, y: number, width: number, height: number,
  area: { x: number; y: number; width: number; height: number }) {
  const keepX = Math.min(180, Math.max(48, area.width - 8))
  const keepY = Math.min(48, Math.max(24, area.height - 8))
  const minX = area.x + keepX - width
  const maxX = area.x + area.width - keepX
  const minY = area.y + keepY - height
  const maxY = area.y + area.height - keepY
  return {
    x: Math.round(Math.min(Math.max(x, Math.min(minX, maxX)), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, Math.min(minY, maxY)), Math.max(minY, maxY))),
    width: Math.round(Math.max(1, width)),
    height: Math.round(Math.max(1, height)),
  }
}
