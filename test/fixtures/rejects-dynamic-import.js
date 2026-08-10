export const meta = { name: 'rejects-dynamic-import' }

const mod = await import('./lib/whatever.mjs')

return { verdict: 'DONE' }
