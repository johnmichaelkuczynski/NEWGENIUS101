/** Keep the actual window, including its bottom resize handle, on screen. */
export function libraryWindowPosition(
  x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number,
) {
  return {
    x: Math.max(12, Math.min(viewportWidth - width - 12, x)),
    y: Math.max(12, Math.min(viewportHeight - height - 12, y)),
  };
}
