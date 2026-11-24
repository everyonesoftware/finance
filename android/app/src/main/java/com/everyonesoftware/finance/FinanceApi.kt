package com.everyonesoftware.finance

import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.ConnectionPool
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer

internal class FinanceFailure(message: String, val status: Int = 0) : IOException(message)

internal class FinanceApi(server: String, allowDebugHttp: Boolean = false) {
    val origin: HttpUrl = parseOrigin(server, allowDebugHttp)
    private val cookieName = if (origin.isHttps) "__Secure-better-auth.session_token" else "better-auth.session_token"
    private var sessionCookie: Cookie? = null
    private val client = OkHttpClient.Builder()
        // Avoid reusing idle sockets closed by intermediaries without replaying writes.
        .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .callTimeout(25, TimeUnit.SECONDS)
        .cookieJar(object : CookieJar {
            private fun exact(url: HttpUrl) = url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                if (!exact(url)) return
                cookies.lastOrNull { it.name == cookieName && it.domain == origin.host && it.path == "/" &&
                    it.httpOnly && (!origin.isHttps || it.secure) }?.let {
                    sessionCookie = it.takeIf { cookie -> cookie.expiresAt > System.currentTimeMillis() }
                }
            }
            override fun loadForRequest(url: HttpUrl): List<Cookie> = listOfNotNull(sessionCookie?.takeIf {
                exact(url) && it.matches(url) && it.expiresAt > System.currentTimeMillis()
            })
        }).build()

    fun signIn(username: String, password: String): String {
        sessionCookie = null
        try {
            request(listOf("api", "auth", "sign-in", "username"), buildJsonObject {
                put("username", username); put("password", password)
            }, read = false)
            if (sessionCookie == null) throw FinanceFailure("The server did not return a Finance session cookie.")
            val session = request(listOf("api", "auth", "get-session"))
            val user = session.obj("user")
            if (session.obj("session").text("userId") != user.text("id")) throw FinanceFailure("Invalid Finance session.")
            return user.text("username")
        } catch (e: Exception) {
            sessionCookie = null
            throw e
        }
    }

    fun signOut() {
        try {
            request(listOf("api", "auth", "sign-out"), buildJsonObject {}, read = false)
        } finally {
            sessionCookie = null
        }
    }

    fun overview() = request(listOf("api", "accounts", "net-worth"))
    fun accounts() = request(listOf("api", "accounts"))
    fun transactions(account: String? = null) = request(if (account == null) {
        listOf("api", "accounts", "transactions", "all")
    } else accountPath(account, "transactions"))
    fun properties() = request(listOf("api", "real-estate"))
    fun investments(account: String) = request(accountPath(account, "investments"))
    fun preview(account: String, body: JsonObject) = request(accountPath(account, "import", "preview"), body)
    fun import(account: String, body: JsonObject) = request(accountPath(account, "import"), body)

    private fun accountPath(id: String, vararg suffix: String): List<String> {
        if (id.isBlank() || id == "." || id == "..") throw FinanceFailure("Invalid account identifier.")
        return listOf("api", "accounts", id, *suffix)
    }

    private fun request(path: List<String>, body: JsonObject? = null, read: Boolean = true): JsonObject {
        val url = origin.newBuilder().apply { path.forEach { addPathSegment(it) } }.build()
        val request = Request.Builder().url(url).header("Accept", "application/json").header("Cache-Control", "no-store")
        if (body != null) {
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            if (bytes.size > 5 * 1024 * 1024) throw FinanceFailure("The encoded import exceeds the server's 5 MiB limit.", 413)
            request.header("Origin", origin.toString().removeSuffix("/"))
                .post(bytes.toRequestBody("application/json".toMediaType()))
        }
        try {
            client.newCall(request.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    val message = when (response.code) {
                        in 300..399 -> "The server redirected. Use its final origin directly."
                        401 -> "Authentication was rejected. Check your credentials or sign in again."
                        403 -> "The server refused this request. Check the configured server origin."
                        404 -> "The server could not find this Finance resource."
                        409 -> "The server detected a conflict. Refresh or preview the import again."
                        413 -> "The server refused the request because it was too large."
                        429 -> "Too many requests. Wait before trying again."
                        else -> "Finance server returned HTTP ${response.code}."
                    }
                    if (response.code == 401) sessionCookie = null
                    throw FinanceFailure(message, response.code)
                }
                if (!read) return buildJsonObject {}
                val source = response.body?.source() ?: throw FinanceFailure("The server returned an empty response.")
                val data = Buffer()
                while (true) {
                    val count = source.read(data, 8192)
                    if (count == -1L) break
                    if (data.size > 24L * 1024 * 1024) throw FinanceFailure("The Finance response exceeds this client's 24 MiB limit.")
                }
                return try {
                    Json.parseToJsonElement(data.readUtf8()) as? JsonObject ?: throw FinanceFailure("Invalid Finance response.")
                } catch (_: IllegalArgumentException) {
                    throw FinanceFailure("Invalid Finance response.")
                }
            }
        } catch (e: FinanceFailure) {
            throw e
        } catch (_: IOException) {
            throw FinanceFailure("Could not reach the Finance server or read its response.")
        }
    }

    companion object {
        fun parseOrigin(server: String, allowDebugHttp: Boolean = false): HttpUrl {
            val message = "Enter the Finance server origin, for example https://finance.example.com (no path)."
            val value = server.trim()
            val uri = try { URI(value) } catch (_: Exception) { throw IllegalArgumentException(message) }
            val url = value.toHttpUrlOrNull() ?: throw IllegalArgumentException(message)
            require(uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.rawPath.isEmpty() || uri.rawPath == "/")) { message }
            require(url.isHttps || (allowDebugHttp && url.host in setOf("localhost", "127.0.0.1", "10.0.2.2"))) {
                "Use HTTPS for your Finance server."
            }
            return url
        }
    }
}

internal fun JsonObject.obj(key: String): JsonObject = this[key] as? JsonObject ?: invalid()
internal fun JsonObject.text(key: String): String = optionalText(key)?.takeIf { it.isNotBlank() } ?: invalid()
internal fun JsonObject.optionalText(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.decimal(key: String): Double? {
    val value = this[key] ?: invalid()
    return if (value == JsonNull) null else (value as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf(Double::isFinite) ?: invalid()
}
internal fun JsonObject.count(key: String): Int = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it >= 0 } ?: invalid()
internal fun JsonObject.flag(key: String): Boolean = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: invalid()
internal fun JsonObject.rows(key: String): List<JsonObject> = (this[key] as? JsonArray)?.map { it as? JsonObject ?: invalid() } ?: invalid()
internal fun invalid(): Nothing = throw FinanceFailure("Invalid Finance response.")
