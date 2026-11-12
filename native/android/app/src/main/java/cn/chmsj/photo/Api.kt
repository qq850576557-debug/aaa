package cn.chmsj.photo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-bound cookie, no password storage, no backup, no global CookieManager or redirects. */
interface SessionStorage {
    fun read(): JSONObject?
    fun save(data: JSONObject)
    fun clear()
}
class SessionVault(context: Context) : SessionStorage {
    private val prefs = context.getSharedPreferences("native-session", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("chunmo-session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("chunmo-session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun read(): JSONObject? { return try {
        val encoded = prefs.getString("sealed", null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        JSONObject(String(c.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    } catch (_: Exception) { null } }
    override fun save(data: JSONObject) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        check(prefs.edit().putString("sealed", Base64.encodeToString(c.iv + c.doFinal(data.toString().toByteArray()), Base64.NO_WRAP)).commit())
    }
    override fun clear() { prefs.edit().remove("sealed").commit() }
}
class Api(private val vault: SessionStorage, private val connection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    var origin = BuildConfig.API_ORIGIN; private set
    private var cookie = ""
    private var csrf = ""
    val hasSession: Boolean get() = cookie.isNotEmpty()
    var identity: Identity? = null; private set
    init { vault.read()?.let {
        if (it.optString("origin") == BuildConfig.API_ORIGIN) cookie = it.optString("cookie")
        else vault.clear() // Never send a saved cookie to a different build's server.
    } }
    fun setOrigin(text: String) {
        val u = URI(text.trim())
        require(text.trim().trimEnd('/') == BuildConfig.API_ORIGIN && u.scheme == "https" && !u.host.isNullOrBlank() && u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null && (u.path.isNullOrEmpty() || u.path == "/")) { "仅允许工作室受控服务器" }
        val next = text.trim().trimEnd('/')
        if (next != origin) { cookie = ""; csrf = ""; identity = null; vault.clear() }
        origin = next
    }
    @Synchronized fun call(path: String, body: JSONObject? = null): JSONObject {
        require(path.startsWith("/api/") && !path.contains(".."))
        val requestOrigin=origin; val requestCookie=cookie; val requestCsrf=csrf
        val c = connection(URL(requestOrigin + path))
        try {
            c.instanceFollowRedirects = false; c.connectTimeout = 15000; c.readTimeout = 20000
            c.requestMethod = if (body == null) "GET" else "POST"
            c.setRequestProperty("Origin", requestOrigin)
            c.setRequestProperty("User-Agent", "ChunmoPhoto/${BuildConfig.VERSION_NAME} Android")
            if (requestCookie.isNotEmpty()) c.setRequestProperty("Cookie", requestCookie)
            if (body != null) {
                c.doOutput = true; c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("X-CSRF-Token", requestCsrf)
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
            val result = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) {
                if (code == 401) { cookie = ""; csrf = ""; identity = null; vault.clear() }
                error(result.optString("error", "请求失败 HTTP $code"))
            }
            c.headerFields.filterKeys { it?.equals("Set-Cookie", true) == true }.values.flatten().forEach {
                val token = it.substringBefore(';')
                if (token.startsWith("chunmo_session=")) cookie = token
            }
            return result
        } finally { c.disconnect() }
    }
    @Synchronized fun login(login: String, password: String) {
        call("/api/auth/login", JSONObject().put("login", login).put("password", password))
        resume()
    }
    @Synchronized fun resume(): Identity {
        val session = call("/api/auth/session"); csrf = session.getString("csrf")
        val user = session.getJSONObject("user"); val config = call("/api/site-photos/config")
        check(config.getString("actorId") == user.getString("id")) { "登录身份校验失败" }
        val result = Identity(user.getString("id"), user.getString("workspaceId"), config.getString("actorName"))
        identity = result
        vault.save(JSONObject().put("origin", origin).put("cookie", cookie))
        return result
    }
    @Synchronized fun logout(): Boolean {
        return try { call("/api/auth/logout", JSONObject()); true } catch (_: Exception) { false }
        finally { cookie = ""; csrf = ""; identity = null; vault.clear() }
    }
}
