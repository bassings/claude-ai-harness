export const meta = { name: 'rejects-new-date' }

const d = new Date()

return { verdict: 'DONE', d: String(d) }
