package cn.chmsj.photo

import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

class ProtocolUnitTest {
    private fun receipt() = JSONObject().put("placeSource","amap-poi-selected").put("placeName","测试工地")
        .put("token","test-only").put("poi",JSONObject().put("id","test"))
        .put("expiresAt",Instant.now().plusSeconds(90).toString())
        .put("location",JSONObject().put("latitude",30).put("longitude",120).put("accuracy",12).put("obtainedAt",Instant.now().toString()))
    @Test fun gpsAndReceiptExpiryCannotBecomeCapturePermission() {
        val p=receipt(); assertTrue(placeFresh(p)); assertFalse(placeFresh(p,System.currentTimeMillis()+91000))
        p.getJSONObject("location").put("accuracy",101); assertFalse(placeFresh(p))
        p.getJSONObject("location").put("accuracy",12).put("obtainedAt",Instant.now().plusSeconds(10).toString()); assertFalse(placeFresh(p))
    }
    @Test fun manualNamesAndUnsignedPlacesAreRejected() {
        val p=receipt(); p.put("placeSource","manual"); assertFalse(placeFresh(p))
        p.put("placeSource","amap-poi-selected").put("token",""); assertFalse(placeFresh(p))
    }
    @Test fun layoutAndShanghaiClockMatchProductionWebSpec() {
        val m=markLayout(4000,3000,"测试现场","2026-11-12T01:02:03Z","测试监理")
        assertEquals(4000f/1100,m.scale,0.0001f); assertEquals(16*m.scale,m.x,0.001f)
        assertEquals(780*m.scale,m.width,0.001f); assertEquals("拍摄时间：2026.11.12 09:02",m.lines[1])
        val portrait=markLayout(3000,4000,"地点".repeat(40),"2026-11-12T01:02:03Z","人")
        assertTrue(portrait.y>0); assertTrue(portrait.lines.all { it.length<=26 })
    }
    @Test fun sameNameIdentitiesRemainDistinctAndNoSecretIsPersisted() {
        assertNotEquals(Identity("a","w","相同姓名").scope,Identity("b","w","相同姓名").scope)
        val vault=JvmVault(); val requests=mutableListOf<JvmConnection>()
        val responses=ArrayDeque(listOf(
            Triple(200,"{\"ok\":true}","chunmo_session="+"a".repeat(64)+"; HttpOnly; Secure"),
            Triple(200,"{\"csrf\":\"server-csrf\",\"user\":{\"id\":\"a\",\"workspaceId\":\"w\"}}",null),
            Triple(200,"{\"actorId\":\"a\",\"actorName\":\"服务器姓名\"}",null),
            Triple(200,"{\"places\":[]}",null)))
        val api=Api(vault) { url -> val (code,body,cookie)=responses.removeFirst(); JvmConnection(url,code,body,cookie).also { requests.add(it) } }
        api.login("existing","not-persisted")
        assertEquals("服务器姓名",api.identity!!.name)
        api.call("/api/site-photos/location",JSONObject().put("nearby",true))
        assertEquals("server-csrf",requests.last().getRequestProperty("X-CSRF-Token"))
        assertEquals("https://chmsj.cn",requests.first().getRequestProperty("Origin"))
        assertTrue(requests.last().getRequestProperty("Cookie").startsWith("chunmo_session="))
        assertFalse(vault.value.toString().contains("not-persisted"))
    }
    @Test fun loginFailureAndRedirectNeverCreateIdentity() {
        for(code in listOf(401,302)) {
            val vault=JvmVault(); val api=Api(vault) { JvmConnection(it,code,"{\"error\":\"test rejection\"}",null) }
            assertThrows(IllegalStateException::class.java) { api.login("a","bad") }; assertNull(api.identity); assertNull(vault.value)
        }
    }
    @Test fun credentialsCannotBeSentToCleartextOrUrlUserInfo() {
        val api=Api(JvmVault())
        for(origin in listOf("http://chmsj.cn","https://name:secret@chmsj.cn","https://chmsj.cn/path","https://chmsj.cn?x=1"))
            assertThrows(IllegalArgumentException::class.java) { api.setOrigin(origin) }
    }
    @Test fun delayedOldSessionCannotClearANewerLogin() {
        val entered=java.util.concurrent.CountDownLatch(1); val release=java.util.concurrent.CountDownLatch(1)
        val sessionCalls=java.util.concurrent.atomic.AtomicInteger(0); val loginCalls=java.util.concurrent.atomic.AtomicInteger(0)
        val vault=JvmVault().apply { value=JSONObject().put("origin","https://chmsj.cn").put("cookie","chunmo_session=old") }
        val api=Api(vault) { url ->
            when {
                url.path=="/api/auth/session" && sessionCalls.getAndIncrement()==0 -> object:JvmConnection(url,401,"{}",null) {
                    override fun getResponseCode(): Int { entered.countDown(); check(release.await(3,java.util.concurrent.TimeUnit.SECONDS)); return 401 }
                }
                url.path=="/api/auth/login" -> { loginCalls.incrementAndGet(); JvmConnection(url,200,"{}","chunmo_session=new") }
                url.path=="/api/auth/session" -> JvmConnection(url,200,"{\"csrf\":\"new\",\"user\":{\"id\":\"b\",\"workspaceId\":\"w\"}}",null)
                else -> JvmConnection(url,200,"{\"actorId\":\"b\",\"actorName\":\"新账号\"}",null)
            }
        }
        val old=kotlin.concurrent.thread { runCatching { api.resume() } }
        assertTrue(entered.await(2,java.util.concurrent.TimeUnit.SECONDS))
        var failure: Throwable?=null
        val next=kotlin.concurrent.thread { failure=runCatching { api.login("new","test") }.exceptionOrNull() }
        Thread.sleep(50); assertEquals(0,loginCalls.get()); release.countDown()
        old.join(3000); next.join(3000)
        assertFalse(next.isAlive); assertNull(failure); assertEquals("b",api.identity!!.id)
    }
}
private class JvmVault : SessionStorage {
    var value: JSONObject?=null
    override fun read()=value
    override fun save(data: JSONObject) { value=data }
    override fun clear() { value=null }
}
private open class JvmConnection(url: URL, private val code: Int, private val text: String, private val cookie: String?) : HttpURLConnection(url) {
    override fun connect() { }; override fun disconnect() { }; override fun usingProxy()=false
    override fun getResponseCode()=code
    override fun getInputStream()=ByteArrayInputStream(text.toByteArray())
    override fun getErrorStream()=ByteArrayInputStream(text.toByteArray())
    override fun getOutputStream()=ByteArrayOutputStream()
    override fun getHeaderFields(): MutableMap<String,MutableList<String>> = mutableMapOf<String,MutableList<String>>().apply { if(cookie!=null) put("Set-Cookie",mutableListOf(cookie)) }
}
