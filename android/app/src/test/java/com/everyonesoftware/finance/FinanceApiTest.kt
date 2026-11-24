package com.everyonesoftware.finance

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class FinanceApiTest {
    @Test fun `only secure bare origins or explicit debug loopback are accepted`() {
        assertEquals("https://finance.example.test/", FinanceApi.parseOrigin(" https://Finance.Example.Test/ ").toString())
        for (url in listOf("http://localhost:3000", "https://u@host.test", "https://host.test/api", "https://host.test/?", "https://host.test/#", "https://host.test/../", "https://host.test\\")) {
            assertThrows(url, IllegalArgumentException::class.java) { FinanceApi.parseOrigin(url) }
        }
        assertEquals("10.0.2.2", FinanceApi.parseOrigin("http://10.0.2.2:3090", true).host)
        assertThrows(IllegalArgumentException::class.java) { FinanceApi.parseOrigin("http://localhost.example.test", true) }
    }

    @Test fun `login validates the cookie with the server and logout clears it even on error`() = MockWebServer().use { server ->
        server.enqueue(MockResponse().setBody("""{"token":"ignored"}""").addHeader("Set-Cookie", "better-auth.session_token=fixture; Path=/; HttpOnly"))
        server.enqueue(MockResponse().setBody("""{"user":{"id":"owner-id","username":"owner"},"session":{"userId":"owner-id"}}"""))
        server.enqueue(MockResponse().setBody("""{"accounts":[]}"""))
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().setResponseCode(401))
        val api = FinanceApi(server.url("/").toString(), true)
        assertEquals("owner", api.signIn("owner", "disposable"))
        api.accounts()
        assertThrows(FinanceFailure::class.java) { api.signOut() }
        assertThrows(FinanceFailure::class.java) { api.accounts() }
        val login = server.takeRequest()
        assertEquals("/api/auth/sign-in/username", login.path)
        assertEquals(server.url("/").toString().removeSuffix("/"), login.getHeader("Origin"))
        val session = server.takeRequest()
        assertEquals("/api/auth/get-session", session.path)
        assertEquals(0, session.sequenceNumber)
        assertEquals("better-auth.session_token=fixture", session.getHeader("Cookie"))
        assertEquals("better-auth.session_token=fixture", server.takeRequest().getHeader("Cookie"))
        val logout = server.takeRequest()
        assertEquals("/api/auth/sign-out", logout.path)
        assertEquals(login.getHeader("Origin"), logout.getHeader("Origin"))
        assertNull(server.takeRequest().getHeader("Cookie"))
    }

    @Test fun `sign-in never follows a redirect to another origin`() = MockWebServer().use { server ->
        MockWebServer().use { redirect ->
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", redirect.url("/capture")))
            assertThrows(FinanceFailure::class.java) { FinanceApi(server.url("/").toString(), true).signIn("owner", "disposable") }
            assertEquals(0, redirect.requestCount)
        }
    }
}