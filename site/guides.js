// The guides' one control: the bulb in the header switches the theme, as on the landing page (which
// adds a pull cord), and remembers it under the same name, so every page opens in the one you chose.
// The page's head restores it before the first paint.
const root = document.documentElement
const bulb = document.getElementById('theme')

function applyTheme(theme) {
  root.dataset.theme = theme
  bulb.setAttribute('aria-label', theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#08080A' : '#FAF8F3'
}

applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
bulb.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try { localStorage.setItem('loomwatch-site-theme', next) } catch { /* private window */ }
})
