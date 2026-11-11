import { prepareFrameEncoder } from '../lib/photo-frame';
import { preparePhotoRenderer } from '../lib/photo-render';
import { useEffect, useRef, useState } from 'react';
import { cloudApi } from '../lib/cloud';
import {
  freshLocation,
  nearbyMapPlace,
  freshPlace,
  type PhotoLocation,
  type PlaceReceipt,
  type NearbyResult,
  type NearbyPlace,
} from '../lib/photo-location';
export function gpsNow(): Promise<PhotoLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(Error('当前浏览器不支持定位，请使用HTTPS访问'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const l = {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          obtainedAt: new Date(p.timestamp).toISOString(),
        };
        freshLocation(l) ? resolve(l) : reject(Error('定位过期或精度不足，请重新定位'));
      },
      (e) =>
        reject(
          Error(
            e.code === 1 ? '定位被拒绝，请在浏览器和系统设置中允许定位' : '定位失败，请重新定位',
          ),
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });
}
export async function renewPlace(p: PlaceReceipt) {
  const location = await gpsNow();
  return cloudApi<PlaceReceipt>('/site-photos/place', 'POST', {
    location,
    previousToken: p.token,
    previousAt: p.resolvedAt,
  });
}
export function NearbyAddress({
  onConfirm,
  onCancel,
}: {
  onConfirm: (p: PlaceReceipt) => void;
  onCancel: () => void;
}) {
  const [location, setLocation] = useState<PhotoLocation | null>(null),
    [places, setPlaces] = useState<NearbyPlace[]>([]),
    [selected, setSelected] = useState<PlaceReceipt | null>(null),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [more, setMore] = useState(false);
  const sequence = useRef(0),
    page = useRef(1),
    queryRef = useRef(query),
    active = useRef(true),
    cache = useRef(new Map<string, NearbyResult>());
  queryRef.current = query;
  async function search(loc: PhotoLocation, text: string, n = 1) {
    const id = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const key = JSON.stringify([loc.obtainedAt, text, n]);
      let r = cache.current.get(key);
      if (!r) {
        r = await cloudApi<NearbyResult>('/site-photos/location', 'POST', {
          location: loc,
          nearby: true,
          query: text,
          page: n,
        });
        if (cache.current.size > 40) cache.current.clear();
        cache.current.set(key, r);
      }
      if (!active.current || id !== sequence.current) return;
      setPlaces((old) =>
        [
          ...new Map(
            [...(n === 1 ? [] : old), ...r!.places.filter((p) => nearbyMapPlace(p.receipt))].map(
              (p) => [p.id, p],
            ),
          ).values(),
        ].sort((a, b) => a.distance - b.distance),
      );
      setMore(r.more);
      page.current = n + 1;
      if (n === 1) setSelected(r.places.find((p) => nearbyMapPlace(p.receipt))?.receipt || null);
      if (!r.places.length && n === 1) setError('2公里内暂无可选高德地点，请重新定位或搜索');
    } catch {
      if (active.current && id === sequence.current) {
        setError('附近地点暂不可用，请重新定位或稍后重试');
        setMore(false);
      }
    } finally {
      if (active.current && id === sequence.current) setBusy(false);
    }
  }
  async function locate() {
    ++sequence.current;
    setBusy(true);
    setError('');
    setSelected(null);
    setPlaces([]);
    setLocation(null);
    try {
      const loc = await gpsNow();
      if (!active.current) return;
      setLocation(loc);
      await search(loc, queryRef.current);
    } catch (e) {
      if (active.current) {
        setError(String(e));
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    preparePhotoRenderer();
    prepareFrameEncoder();
    void locate();
    return () => {
      active.current = false;
      ++sequence.current;
    };
  }, []);
  useEffect(() => {
    if (!location) return;
    const t = setTimeout(() => void search(location, query), 350);
    return () => clearTimeout(t);
  }, [query]);
  async function refreshSelected() {
    setBusy(true);
    try {
      const p = await renewPlace(selected!);
      if (active.current) {
        setSelected(p);
        setLocation(p.location);
        setError('位置已更新，请再次确认地址');
      }
    } catch (e) {
      if (active.current) setError(String(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="photo-address" role="dialog" aria-modal="true" aria-label="选择拍摄地址">
      <header>
        <h2>选择地址</h2>
        <button onClick={onCancel}>取消</button>
      </header>
      <input
        type="search"
        aria-label="搜索附近地点"
        maxLength={80}
        placeholder="搜索附近2公里地点"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="nearby-list" role="listbox" aria-label="附近地点列表">
        {places.map((p) => (
          <button
            key={p.id}
            role="option"
            aria-selected={selected?.poi?.id === p.id}
            onClick={() => setSelected(p.receipt)}
          >
            <span>
              <strong>{p.name}</strong>
              <small>{p.address}</small>
            </span>
            <span>
              {p.distance}米 {selected?.poi?.id === p.id ? '✓' : ''}
            </span>
          </button>
        ))}
        {more && (
          <button
            disabled={busy}
            onClick={() => location && void search(location, query, page.current)}
          >
            加载更多
          </button>
        )}
      </div>
      {selected && <p>已选：{selected.placeName}</p>}
      {busy && <p role="status">正在定位或查询…</p>}
      {error && <p role="status">{error}</p>}
      <footer>
        <button disabled={busy} onClick={() => void locate()}>
          重新定位
        </button>
        <button
          className="primary"
          disabled={busy || !nearbyMapPlace(selected)}
          onClick={() => {
            if (selected) {
              if (freshPlace(selected)) onConfirm(selected);
              else void refreshSelected();
            }
          }}
        >
          确认地址并拍摄
        </button>
      </footer>
    </section>
  );
}
