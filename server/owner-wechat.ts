import { ApiError } from './store';

const host = 'https://api.weixin.qq.com';
export type OwnerWechat = {
  appId: string;
  verify(loginCode: string, phoneCode: string): Promise<{ openid: string; phone: string }>;
};

export function officialOwnerWechat(appId: string, secret: string, http = fetch): OwnerWechat {
  let cached: { value: string; until: number } | undefined;
  let refresh: Promise<string> | undefined;

  async function json(url: URL, body?: object) {
    try {
      const response = await http(url, {
        ...(body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw Error();
      return await response.json();
    } catch {
      // Provider replies and URLs may contain secrets or personal information.
      throw new ApiError(503, '微信身份服务暂时不可用，请稍后重试');
    }
  }

  function accessToken() {
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    refresh ??= (async () => {
      const result = await json(new URL(host + '/cgi-bin/stable_token'), {
        grant_type: 'client_credential',
        appid: appId,
        secret,
      });
      if (typeof result?.access_token !== 'string' || !(result.expires_in > 120))
        throw new ApiError(503, '微信手机号能力暂时不可用');
      cached = { value: result.access_token, until: Date.now() + (result.expires_in - 120) * 1000 };
      return cached.value;
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }

  return {
    appId,
    async verify(loginCode, phoneCode) {
      const login = new URL(host + '/sns/jscode2session');
      login.search = new URLSearchParams({
        appid: appId,
        secret,
        js_code: loginCode,
        grant_type: 'authorization_code',
      }).toString();
      const identity = await json(login);
      if (
        identity?.errcode ||
        typeof identity?.openid !== 'string' ||
        !/^[\w-]{1,128}$/.test(identity.openid)
      )
        throw new ApiError(401, '微信登录已失效，请重新授权');
      const endpoint = new URL(host + '/wxa/business/getuserphonenumber');
      endpoint.searchParams.set('access_token', await accessToken());
      const result = await json(endpoint, { code: phoneCode });
      const info = result?.phone_info;
      if (result?.errcode === 40001 || result?.errcode === 42001) cached = undefined;
      if (
        result?.errcode !== 0 ||
        info?.countryCode !== '86' ||
        info?.watermark?.appid !== appId ||
        typeof info?.purePhoneNumber !== 'string' ||
        !/^1[3-9][0-9]{9}$/.test(info.purePhoneNumber)
      )
        throw new ApiError(401, '无法验证微信手机号，请重新授权');
      return { openid: identity.openid, phone: info.purePhoneNumber };
    },
  };
}
