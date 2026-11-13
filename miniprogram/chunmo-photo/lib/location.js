const { call, privacy } = require('./platform');
function fresh(place, now = Date.now()) {
  const l = place && place.location,
    age = l ? now - Date.parse(l.obtainedAt) : Infinity;
  return !!(
    place &&
    place.token &&
    place.poi &&
    place.poi.id &&
    place.placeSource === 'amap-poi-selected' &&
    l.accuracy >= 0 &&
    l.accuracy <= 100 &&
    age >= -5000 &&
    age <= 90000 &&
    now <= Date.parse(place.expiresAt)
  );
}
async function locate() {
  await privacy();
  const l = await call('getLocation', {
    type: 'wgs84',
    isHighAccuracy: true,
    highAccuracyExpireTime: 8000,
  });
  if (
    !Number.isFinite(l.latitude) ||
    !Number.isFinite(l.longitude) ||
    !Number.isFinite(l.accuracy) ||
    l.accuracy < 0 ||
    l.accuracy > 100
  )
    throw Error('定位精度不足100米，请到开阔处重新定位');
  return {
    latitude: l.latitude,
    longitude: l.longitude,
    accuracy: l.accuracy,
    obtainedAt: new Date().toISOString(),
  };
}
function mergePlaces(old, next) {
  const all = new Map(old.filter((p) => fresh(p.receipt)).map((p) => [p.id, p]));
  for (const p of next)
    if (fresh(p.receipt) && Number.isFinite(p.distance) && p.distance >= 0 && p.distance <= 2000)
      all.set(p.id, p);
  return Array.from(all.values()).sort(
    (a, b) => a.distance - b.distance || a.id.localeCompare(b.id),
  );
}
async function renew(api, previous) {
  const location = await locate();
  return api.request('renew', {
    location,
    previousToken: previous.token,
    previousAt: previous.resolvedAt,
  });
}
module.exports = { locate, fresh, mergePlaces, renew };
