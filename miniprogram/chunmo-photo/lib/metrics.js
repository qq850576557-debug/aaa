// Bounded numeric stages only: no identity, password, session, GPS or image bytes.
const events = [];
function record(stage, started, extra = {}) {
  const e = { stage, ms: Date.now() - started, at: new Date().toISOString(), ...extra };
  events.push(e);
  if (events.length > 240) events.shift();
  console.info('[chunmo-photo]', JSON.stringify(e));
}
module.exports = { record, snapshot: () => events.slice() };
