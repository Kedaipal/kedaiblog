import {copyText, toast} from './lib/ui.js'

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]')
  if (!btn) return
  const ok = await copyText(btn.dataset.copy)
  toast(ok ? 'Link copied' : 'Could not copy — select the link and copy it by hand')
})
