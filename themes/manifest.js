/* Theme manifest — data only.
 * Add { id, name, layout, file } and a CSS file at themes/<id>/<id>.css.
 * layout picks an arrangement in styles.css; omit it for classic.
 * glyphs: "ransom" opts into the cut-paper heading splitter.
 */
window.SD_THEME_MANIFEST = [
  { id: "pit", name: "Mosh Pit", layout: "classic", file: "themes/pit/pit.css" },
  { id: "punk", name: "Punk Rock", layout: "flyer", file: "themes/punk/punk.css", glyphs: "ransom" },
  { id: "ska", name: "Ska — Light", layout: "two-tone", file: "themes/ska/ska.css" },
  { id: "ska-dark", name: "Ska — Dark", layout: "two-tone", file: "themes/ska-dark/ska-dark.css" },
  { id: "zine", name: "Photocopy Zine", layout: "broadsheet", file: "themes/zine/zine.css" },
];
