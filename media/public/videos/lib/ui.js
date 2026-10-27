/* Tiny DOM helpers shared by the upload page and /recent. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'text') node.textContent = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return node
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.append(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

let toastTimer
export function toast(message) {
  const node = document.getElementById('toast')
  if (!node) return
  node.textContent = message
  node.hidden = false
  node.classList.add('is-on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.classList.remove('is-on')
    setTimeout(() => (node.hidden = true), 250)
  }, 2200)
}
