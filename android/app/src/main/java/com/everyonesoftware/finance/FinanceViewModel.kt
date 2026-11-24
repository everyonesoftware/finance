package com.everyonesoftware.finance

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

internal enum class Tab(val label: String, val symbol: String) {
    Overview("Overview", "◈"), Accounts("Accounts", "▤"), Transactions("Transactions", "↕"),
    Property("Property", "⌂"), Settings("Settings", "⚙")
}

internal data class LedgerRow(val title: String, val detail: String, val value: String = "", val account: String? = null)
internal data class AccountRef(val id: String, val name: String, val currency: String, val canImport: Boolean, val investment: Boolean)
internal data class LedgerPage(
    val headline: String? = null, val caption: String? = null, val rows: List<LedgerRow> = emptyList(),
    val account: AccountRef? = null, val history: List<Double> = emptyList()
)
internal data class ImportReview(val summary: String, val errors: List<String>, val examples: List<LedgerRow>, val confirm: Boolean)
private class ImportDraft(val account: AccountRef, val file: JsonObject, val token: String?, val review: ImportReview)

internal class FinanceViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("finance.connection", 0)
    var server by mutableStateOf(prefs.getString("origin", "").orEmpty())
    var username by mutableStateOf(prefs.getString("username", "").orEmpty())
    var displayName by mutableStateOf<String?>(null); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null); private set
    var tab by mutableStateOf(Tab.Overview); private set
    var selected by mutableStateOf<String?>(null); private set
    var page by mutableStateOf<LedgerPage?>(null); private set
    var query by mutableStateOf("")
    private var api: FinanceApi? = null
    private var draft by mutableStateOf<ImportDraft?>(null)
    val importReview get() = draft?.review

    fun signIn(password: String) {
        if (busy || username.isBlank() || password.isEmpty()) return
        val endpoint = server
        val user = username.trim()
        runRequest {
            val candidate = FinanceApi(endpoint, BuildConfig.DEBUG)
            val name = withContext(Dispatchers.IO) { candidate.signIn(user, password) }
            api = candidate
            server = candidate.origin.toString().removeSuffix("/")
            username = name
            prefs.edit { putString("origin", server); putString("username", name) }
            displayName = name
            tab = Tab.Overview
            page = load(candidate, tab, null)
        }
    }

    fun navigate(next: Tab, account: String? = null) {
        if (busy) return
        val current = api ?: return
        tab = next
        selected = account
        query = ""
        page = null
        notice = null
        draft = null
        if (next == Tab.Settings) { error = null; return }
        runRequest { page = load(current, next, account) }
    }

    fun refresh() {
        if (busy || draft != null) return
        val current = api ?: return
        page = null
        notice = null
        runRequest { page = load(current, tab, selected) }
    }

    fun signOut() {
        if (busy) return
        val current = api ?: return
        reset()
        runRequest {
            try { withContext(Dispatchers.IO) { current.signOut() } }
            catch (_: FinanceFailure) { notice = "Signed out on this device. Server sign-out could not be confirmed." }
        }
    }

    private fun reset() {
        api = null; displayName = null; page = null; draft = null
        selected = null; query = ""; notice = null; tab = Tab.Overview
    }

    fun chooseImport(uri: Uri?) {
        if (uri == null || busy) return
        val current = api ?: return
        val account = page?.account?.takeIf { it.id == selected && it.canImport } ?: return
        notice = null
        runRequest {
            draft = withContext(Dispatchers.IO) {
                val resolver = getApplication<Application>().contentResolver
                val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                } ?: throw FinanceFailure("Could not read the document name.")
                if (name.length > 255 || name.substringAfterLast('.', "").lowercase(Locale.ROOT) !in setOf("ofx", "qfx", "csv")) {
                    throw FinanceFailure("Choose a CSV, OFX, or QFX statement.")
                }
                val content = resolver.openInputStream(uri)?.use { input ->
                    val data = java.io.ByteArrayOutputStream()
                    val chunk = ByteArray(8192)
                    while (true) {
                        val count = input.read(chunk)
                        if (count == -1) break
                        if (data.size() + count > 5 * 1024 * 1024) throw FinanceFailure("The file exceeds 5 MiB.")
                        data.write(chunk, 0, count)
                    }
                    data.toString("UTF-8")
                } ?: throw FinanceFailure("Could not open the selected file.")
                val file = buildJsonObject { put("fileName", name); put("content", content) }
                val preview = current.preview(account.id, file)
                val errors = (preview["errors"] as? JsonArray)?.map {
                    (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content ?: invalid()
                } ?: invalid()
                val count = preview.count("importable")
                val duplicates = preview.count("duplicates")
                val impact = preview.obj("balanceImpact")
                val token = preview.text("previewToken")
                val summary = buildString {
                    append("$name\n${account.name}\n$count new · $duplicates duplicate\n")
                    append("Balance: ${money(impact.decimal("startingBalance"), account.currency)} → ${money(impact.decimal("balanceAfterImport"), account.currency)}")
                    if (preview.flag("previewTruncated")) append("\nServer preview limited to the first 50 rows.")
                    impact.optionalText("reason")?.let { append("\n$it") }
                }
                val examples = preview.rows("transactions").map { transactionRow(it) }
                ImportDraft(account, file, token, ImportReview(summary, errors, examples, errors.isEmpty() && count > 0))
            }
        }
    }

    fun cancelImport() { if (!busy) draft = null }

    fun confirmImport() {
        if (busy) return
        val current = api ?: return
        val proposal = draft?.takeIf { it.review.confirm && it.account.id == selected } ?: return
        val token = proposal.token ?: return
        draft = null
        runRequest {
            try {
                val result = withContext(Dispatchers.IO) {
                    current.import(proposal.account.id, JsonObject(proposal.file + ("previewToken" to JsonPrimitive(token))))
                }
                notice = "Imported ${result.count("imported")} transactions; ${result.count("skipped")} duplicates skipped."
            } catch (e: FinanceFailure) {
                if (e.status == 401 || e.status == 409) throw e
                page = null
                throw FinanceFailure("Import could not be confirmed. Refresh the account before trying again.")
            }
            page = null
            page = load(current, Tab.Accounts, proposal.account.id)
        }
    }

    private fun runRequest(action: suspend () -> Unit) {
        busy = true
        error = null
        viewModelScope.launch {
            try { action() }
            catch (e: CancellationException) { throw e }
            catch (e: FinanceFailure) {
                val expired = e.status == 401 && api != null
                if (expired) reset()
                error = if (expired) "Your Finance session expired. Sign in again." else e.message
            }
            catch (e: IllegalArgumentException) { error = if (api == null) e.message else "Invalid Finance response or document." }
            catch (_: Exception) { error = "Unable to complete the Finance request." }
            finally { busy = false }
        }
    }
}

internal fun money(value: Double?, currency: String): String {
    if (value == null) return "Unavailable"
    val unit = runCatching { Currency.getInstance(currency) }.getOrNull()
    return if (unit == null) "${NumberFormat.getNumberInstance().format(value)} $currency" else
        NumberFormat.getCurrencyInstance().apply {
            this.currency = unit
            val digits = unit.defaultFractionDigits.coerceAtLeast(0)
            minimumFractionDigits = digits; maximumFractionDigits = digits
        }.format(value)
}

private fun transactionRow(tx: JsonObject, accountName: String? = null, currency: String = ""): LedgerRow = LedgerRow(
    tx.optionalText("merchant_name")?.takeIf(String::isNotBlank) ?: tx.text("name"),
    listOfNotNull(tx.text("date"), accountName, "Pending".takeIf { (tx["pending"] as? JsonPrimitive)?.booleanOrNull == true }).joinToString(" · "),
    money(tx.decimal("amount"), tx.optionalText("iso_currency_code") ?: tx.optionalText("unofficial_currency_code") ?: currency)
)

private fun accountRow(account: JsonObject) = LedgerRow(
    account.text("name"), listOfNotNull(account.text("institutionName"), account.optionalText("subtype"), account.optionalText("mask")?.let { "••$it" }).joinToString(" · "),
    money(account.decimal("currentBalance"), account.optionalText("currencyCode") ?: ""), account.text("id")
)

private suspend fun load(api: FinanceApi, tab: Tab, selected: String?): LedgerPage = withContext(Dispatchers.IO) {
    when (tab) {
        Tab.Overview -> {
            val data = api.overview()
            val currency = data.text("currencyCode")
            val points = data.rows("points").sortedBy { it.text("date") }
            LedgerPage(money(data.decimal("total"), currency),
                "${data.count("includedAccountCount")} of ${data.count("accountCount")} accounts included · " +
                    "${data.count("unknownBalanceCount")} unknown · ${data.count("excludedAccountCount")} non-$currency",
                rows = points.takeLast(5).asReversed().map { LedgerRow(it.text("date"),
                    if (it.optionalText("source") == "reconstructed") "Reconstructed" else "Observed", money(it.decimal("total"), currency)) },
                history = points.map { it.decimal("total") ?: invalid() })
        }
        Tab.Accounts -> if (selected == null) {
            LedgerPage(rows = api.accounts().rows("accounts").map(::accountRow).sortedBy { it.title.lowercase(Locale.ROOT) })
        } else {
            val data = api.transactions(selected)
            val account = data.obj("account")
            if (account.text("id") != selected) invalid()
            val row = accountRow(account)
            val ref = AccountRef(selected, row.title, account.optionalText("currencyCode") ?: "", account.flag("canImport"), account.text("type") == "investment")
            val snapshots = if (ref.investment) api.investments(selected).rows("snapshots").map {
                LedgerRow("Valuation · ${it.text("valuationDate")}", "${it.text("source")} · ${it.rows("holdings").size} holdings", money(it.decimal("accountValue"), ref.currency))
            } else emptyList()
            LedgerPage(row.value, row.detail, snapshots + data.rows("transactions").map { transactionRow(it, currency = ref.currency) }, ref)
        }
        Tab.Transactions -> {
            val data = api.transactions()
            val accounts = data.rows("accounts").associateBy { it.text("providerAccountId") }
            LedgerPage(rows = data.rows("transactions").sortedByDescending { it.text("date") }.map {
                val account = accounts[it.optionalText("account_id")]
                transactionRow(it, account?.text("name"), account?.optionalText("currencyCode").orEmpty())
            })
        }
        Tab.Property -> LedgerPage(rows = api.properties().rows("properties").map { property ->
            val estimate = property.rows("estimates").firstOrNull()
            LedgerRow(property.text("address"), estimate?.text("provider")?.replaceFirstChar { it.titlecase(Locale.ROOT) } ?: "No estimate",
                estimate?.let { money(it.decimal("amount"), "USD") }.orEmpty())
        })
        Tab.Settings -> LedgerPage()
    }
}
