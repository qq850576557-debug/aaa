import { expect, it } from 'vitest';
import {
  freshLocation,
  freshPlace,
  nearbyPlace,
  wgsToGcj,
  type PlaceReceipt,
} from './photo-location';
it('session place cache respects GPS age, signed expiry and the short reuse window', () => {
  const now = Date.now();
  const p: PlaceReceipt = {
    location: {
      latitude: 30,
      longitude: 120,
      accuracy: 12,
      obtainedAt: new Date(now).toISOString(),
    },
    token: 'signed',
    placeName: '附近小区',
    placeSource: 'amap',
    nearby: true,
    resolvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90000).toISOString(),
  };
  expect(freshPlace(p, now + 25000, 30000)).toBe(true);
  expect(freshPlace(p, now + 31000, 30000)).toBe(false);
  expect(freshPlace(p, now + 91000)).toBe(false);
  expect(freshPlace({ ...p, expiresAt: new Date(now - 1).toISOString() }, now)).toBe(false);
  expect(freshPlace({ ...p, token: '' }, now)).toBe(false);
  expect(freshPlace({ ...p, location: { ...p.location, accuracy: 101 } }, now)).toBe(false);
});
it('WGS84 is retained separately and translated correctly for AMap', () => {
  const p = wgsToGcj(39.908823, 116.39747);
  expect(p.latitude).toBeCloseTo(39.910226, 4);
  expect(p.longitude).toBeCloseTo(116.403714, 4);
  expect(wgsToGcj(51, -0.1)).toEqual({ latitude: 51, longitude: -0.1 });
});
it('refuses stale, future and imprecise location', () => {
  const now = Date.now(),
    l = { latitude: 30, longitude: 120, accuracy: 12, obtainedAt: new Date(now).toISOString() };
  expect(freshLocation(l, now)).toBe(true);
  expect(freshLocation({ ...l, accuracy: 101 }, now)).toBe(false);
  expect(freshLocation(l, now + 91000)).toBe(false);
  expect(freshLocation(l, now - 10000)).toBe(false);
});
it('nearby AOI has no boundary proof and cannot select an unrelated nearest shop', () => {
  expect(
    nearbyPlace({
      status: '1',
      regeocode: {
        aois: [
          { name: '便利店', type: '060100', distance: '0' },
          { name: '宝嘉誉府', type: '120302', distance: '24' },
        ],
      },
    }),
  ).toEqual({ name: '宝嘉誉府', source: 'amap-regeo-aoi-nearby' });
  expect(
    nearbyPlace({
      status: '1',
      regeocode: { aois: [{ name: '未证明小区', type: '120302', distance: '500' }] },
    }),
  ).toBeNull();
  expect(nearbyPlace({ status: '0' })).toBeNull();
});
