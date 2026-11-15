// The diagram's 100%: drawings are scaled by BASE_ZOOM so that their text,
// lines and symbols sit well with the interface's own fonts. The store's
// zoom is the actual scale; the percentage shown is relative to BASE_ZOOM.
export const BASE_ZOOM = 0.8
export const zoomPercent = zoom => Math.round((zoom / BASE_ZOOM) * 100)
