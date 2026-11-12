import { http } from '@kit.NetworkKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { Identity, Login, Session, PhotoConfig, Failure } from './Protocol';

/** Memory-only native session; no plaintext password/cookie persistence and no second account system. */
export class Api {
  origin: string = 'https://chmsj.cn';
  cookie: string = '';
  csrf: string = '';
  actor?: Identity;
  setOrigin(value: string): void {
    const s = value.trim().replace(/\/$/, '');
    if (!/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(s)) throw new Error('请输入无路径的HTTPS地址');
    if (s !== this.origin) { this.cookie=''; this.csrf=''; this.actor=undefined; }
    this.origin=s;
  }
  async request(path: string, body: string=''): Promise<string> {
    // Verified public declaration: maxRedirects starts at API 23. Fail closed on older SDKs.
    // HarmonyOS 6.1's installed SDK/API must be checked in DevEco before distribution.
    if (deviceInfo.sdkApiVersion < 23) throw new Error('此SDK缺少已核验的原生网络重定向保护；请先完成目标鸿蒙SDK适配，不发送账号密码');
    if (!path.startsWith('/api/') || path.includes('..')) throw new Error('接口路径无效');
    const client = http.createHttp();
    try {
      const options: NativeRequestOptions = {
        method: body.length > 0 ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: { 'Origin':this.origin, 'Cookie':this.cookie, 'X-CSRF-Token':this.csrf, 'Content-Type':'application/json', 'User-Agent':'ChunmoPhoto/1.0 Harmony' },
        extraData:body, connectTimeout:15000, readTimeout:20000, usingCache:false,
        expectDataType:http.HttpDataType.STRING,
        maxRedirects:0,
      };
      const result = await client.request(this.origin+path, options);
      // Never follow an authentication redirect or use a response as an album-save receipt.
      if (result.responseCode < 200 || result.responseCode >= 300) {
        if (result.responseCode === 401) { this.actor=undefined; this.cookie=''; this.csrf=''; }
        const failure = JSON.parse(result.result as string) as Failure;
        throw new Error(failure.error || `HTTP ${result.responseCode}`);
      }
      const header = result.header as Record<string, string | string[]>;
      const cookies = header['set-cookie'];
      const values: string[] = typeof cookies === 'string' ? [cookies] : (cookies || []);
      values.forEach((entry: string) => { const token = entry.split(';')[0]; if (token.startsWith('chunmo_session=')) this.cookie=token; });
      return result.result as string;
    } finally { client.destroy(); }
  }
  async login(account: string, password: string): Promise<Identity> {
    const data: Login = { login:account, password:password };
    await this.request('/api/auth/login',JSON.stringify(data));
    const session = JSON.parse(await this.request('/api/auth/session')) as Session;
    this.csrf=session.csrf;
    const config = JSON.parse(await this.request('/api/site-photos/config')) as PhotoConfig;
    if (config.actorId !== session.user.id) throw new Error('账号身份不一致');
    const actor: Identity = { id:session.user.id, workspaceId:session.user.workspaceId, name:config.actorName };
    this.actor=actor; return actor;
  }
}
interface NativeRequestOptions extends http.HttpRequestOptions { maxRedirects: number; }
