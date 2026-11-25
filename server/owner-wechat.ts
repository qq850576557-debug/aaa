import { ApiError } from './store';

const host = 'https://api.weixin.qq.com';
async function wechatJson(http: typeof fetch, url: URL, body?: object) {
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

export async function wechatOpenId(appId: string, secret: string, code: string, http = fetch) {
  const url = new URL(host + '/sns/jscode2session');
  url.search = new URLSearchParams({
    appid: appId,
    secret,
    js_code: code,
    grant_type: 'authorization_code',
  }).toString();
  const identity = await wechatJson(http, url);
  if (
    identity?.errcode ||
    typeof identity?.openid !== 'string' ||
    !/^[\w-]{1,128}$/.test(identity.openid)
  )
    throw new ApiError(401, '微信登录已失效，请重新授权');
  return identity.openid as string;
}

export type OwnerWechat = {
  appId: string;
  phone?(phoneCode: string): Promise<string>;
  verify(loginCode: string, phoneCode: string): Promise<{ openid: string; phone: string }>;
};

export function officialOwnerWechat(appId: string, secret: string, http = fetch): OwnerWechat {
  let cached: { value: string; until: number } | undefined;
  let refresh: Promise<string> | undefined;

  function accessToken() {
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    refresh ??= (async () => {
      const result = await wechatJson(http, new URL(host + '/cgi-bin/stable_token'), {
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

  async function phone(phoneCode: string) {
    const endpoint = new URL(host + '/wxa/business/getuserphonenumber');
    endpoint.searchParams.set('access_token', await accessToken());
    const result = await wechatJson(http, endpoint, { code: phoneCode });
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
    return info.purePhoneNumber as string;
  }
  return {
    appId,
    phone,
    async verify(loginCode, phoneCode) {
      const openid = await wechatOpenId(appId, secret, loginCode, http);
      return { openid, phone: await phone(phoneCode) };
    },
  };
}
