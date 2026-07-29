/**
 * The chat wallpaper catalogue.
 *
 * The server stores an ID, never a URL or a colour. Each client then renders
 * its own bundled asset for that id at its own resolution — the phone does not
 * download a web-sized image and the browser does not download a phone-sized
 * one, and neither has to re-fetch anything when the artwork is retouched.
 *
 * This list is the contract. It exists so the server can reject an id no client
 * can draw, which would otherwise be stored happily and then render as nothing.
 * Adding a wallpaper means adding it here AND adding the matching asset to both
 * clients; the id is what ties the three together.
 *
 * NULL IS THE DEFAULT AND MEANS "NO WALLPAPER". A chat with no wallpaper set
 * must look exactly as it did before this feature existed — not a white
 * wallpaper, not a default one. Nothing.
 */

export const CHAT_WALLPAPERS = [
    // Plain tones. Deliberately low-saturation: message bubbles and the grey
    // timestamps outside them have to stay readable on top.
    { id: 'sand', label: 'Sand', kind: 'solid' },
    { id: 'mist', label: 'Mist', kind: 'solid' },
    { id: 'sage', label: 'Sage', kind: 'solid' },
    { id: 'dusk', label: 'Dusk', kind: 'solid' },
    { id: 'charcoal', label: 'Charcoal', kind: 'solid' },

    // Soft gradients.
    { id: 'sunrise', label: 'Sunrise', kind: 'gradient' },
    { id: 'ocean', label: 'Ocean', kind: 'gradient' },
    { id: 'plum', label: 'Plum', kind: 'gradient' },

    // Light patterns, low contrast by design.
    { id: 'dots', label: 'Dots', kind: 'pattern' },
    { id: 'weave', label: 'Weave', kind: 'pattern' },
];

export const CHAT_WALLPAPER_IDS = CHAT_WALLPAPERS.map((w) => w.id);

/** null / '' / 'none' all mean "no wallpaper" and are accepted for clearing. */
export const isValidWallpaperId = (value) =>
    value === null || value === '' || value === 'none' || CHAT_WALLPAPER_IDS.includes(value);

/** Normalises anything meaning "cleared" to null, so one value is stored. */
export const normaliseWallpaperId = (value) =>
    (value === '' || value === 'none' || value === undefined) ? null : value;
