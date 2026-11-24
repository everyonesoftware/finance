package com.everyonesoftware.finance

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.AnnotatedString
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class FinanceLiveTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()

    @Test fun signsInAndNavigatesTheRealServer() {
        val args = InstrumentationRegistry.getArguments()
        val server = args.getString("financeOrigin")
        assumeTrue("Run android/verify-live.mjs to provision an isolated Finance server", server != null)
        fun enter(label: String, value: String) {
            ui.onNodeWithText(label).performTextReplacement(value)
        }
        fun tap(label: String) = ui.onNode((hasText(label) or hasContentDescription(label)) and hasClickAction())
            .assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
        fun wait(label: String) {
            try { ui.waitUntilAtLeastOneExists(hasText(label), 40_000) }
            catch (e: ComposeTimeoutException) {
                if (ui.onAllNodesWithTag("workspace").fetchSemanticsNodes().isNotEmpty()) {
                    throw AssertionError("Expected $label:\n${ui.onNodeWithTag("workspace").printToString()}", e)
                }
                throw e
            }
        }
        fun field(tag: String, value: String) = ui.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.SetText) { assertTrue(it(AnnotatedString(value))) }
        fun submit() = ui.onNodeWithTag("sign-in").performScrollTo().assertIsEnabled().performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
        fun open(tab: Tab) {
            val node = ui.onNodeWithTag("tab-${tab.name}").assertExists().assertIsEnabled()
            node.performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
            node.assertIsSelected()
        }
        field("server", requireNotNull(server))
        field("username", "native_owner")
        field("password", "invalid-disposable-password")
        submit()
        wait("Authentication was rejected. Check your credentials or sign in again.")
        field("password", requireNotNull(args.getString("financePassword")))
        submit()
        wait("$174.39")
        open(Tab.Accounts)
        wait("Native checking")
        tap("Native checking")
        wait("Fixture groceries")
        open(Tab.Transactions)
        wait("Fixture groceries")
        enter("Search transactions", "no-match")
        wait("No matching transactions.")
        enter("Search transactions", "groceries")
        wait("Fixture groceries")
        open(Tab.Property)
        wait("123 Android Test Ave")
        open(Tab.Settings)
        wait("Current Version: 0.1.0")
        tap("Sign out")
        wait("Sign in")
        ui.onNodeWithText("Fixture groceries").assertDoesNotExist()
    }

    @Test fun previewsAndCommitsAStatementThroughTheRealAndroidTransport() {
        val args = InstrumentationRegistry.getArguments()
        val origin = args.getString("financeOrigin")
        assumeTrue("Run android/verify-live.mjs", origin != null)
        val api = FinanceApi(requireNotNull(origin), true)
        assertEquals("native_owner", api.signIn("native_owner", requireNotNull(args.getString("financePassword"))))
        try {
            val id = api.accounts().rows("accounts").single().text("id")
            val file = buildJsonObject {
                put("fileName", "android.csv")
                put("content", "Date,Description,Amount\n2024-01-03,Imported by Android,-9.87\n")
            }
            val review = api.preview(id, file)
            assertEquals(1, review.count("importable"))
            assertFalse(api.transactions(id).rows("transactions").any { it.text("name") == "Imported by Android" })
            val changed = JsonObject(file + ("previewToken" to JsonPrimitive("stale-fixture")))
            assertEquals(409, assertThrows(FinanceFailure::class.java) { api.import(id, changed) }.status)
            val confirmed = JsonObject(file + ("previewToken" to JsonPrimitive(review.text("previewToken"))))
            assertEquals(1, api.import(id, confirmed).count("imported"))
            assertTrue(api.transactions(id).rows("transactions").any { it.text("name") == "Imported by Android" })
            assertEquals(0, api.preview(id, file).count("importable"))
        } finally { api.signOut() }
        assertEquals(401, assertThrows(FinanceFailure::class.java) { api.accounts() }.status)
    }
}
