"""Check the synthetic founder and authorized route on the test HTTPS origin."""
from http.cookiejar import CookieJar
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import URLError
from urllib.parse import quote

ORIGIN = "https://owner-test.chmsj.cn"
text = Path(sys.argv[1]).read_text()
value = re.search(r"^测试密码 ([a-f0-9]{32})$", text, re.M)
if not value:
    raise SystemExit("找不到本次生成的测试账号")
opener = build_opener(HTTPCookieProcessor(CookieJar()))


def api(path, body=None):
    request = Request(ORIGIN + "/api" + path,
                      data=json.dumps(body).encode("ascii") if body is not None else None,
                      headers={"Origin": ORIGIN, "Content-Type": "application/json"})
    with opener.open(request, timeout=12) as result:
        return json.load(result)


try:
    assert api("/auth/login", {"login": "owner-test-admin", "password": value.group(1)})["ok"] is True
    assert api("/auth/session")["user"]["owner"] is True
    projects = api("/workspace")["data"]["projects"]
    if "--upgrade" in sys.argv[2:]:
        result = api("/owner-purchases")
        assert {row["id"] for row in result["projects"]} == {p["id"] for p in projects}
        assert isinstance(result["items"], list)
        if "--design" in sys.argv[2:]:
            assert projects
            design = api("/projects/" + quote(projects[0]["id"], safe="") + "/owner-design")
            assert all(isinstance(design[key], str) for key in ("rendering", "panorama"))
            assert isinstance(design["version"], int) and isinstance(design["origins"], list)
    else:
        assert len(projects) == 2 and all("（测试）" in item["name"] for item in projects)
        assert api("/projects/" + projects[0]["id"] + "/owner-access") == {"enabled": False, "members": []}
except (URLError, ValueError, KeyError, TypeError, AssertionError):
    raise SystemExit("测试账号或初始授权状态校验失败")
if "--design" in sys.argv[2:]:
    print("隔离负责人登录、采购及设计成果接口已核验")
else:
    print("隔离负责人登录及测试采购接口已核验" if sys.argv[2:] else "隔离负责人登录、两个测试住宅和默认授权关闭已核验")
