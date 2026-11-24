package com.everyonesoftware.finance

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Color(0xFF9CF2C4), onPrimary = Color(0xFF072218),
                background = Color(0xFF101916), surface = Color(0xFF16241F),
                onSurface = Color(0xFFE3EEE7), onSurfaceVariant = Color(0xFFB8CDC2)
            )) { FinanceScreen(viewModel()) }
        }
    }
}

@Composable
private fun FinanceScreen(model: FinanceViewModel) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), model::chooseImport)
    val signedInUser = model.displayName
    BackHandler(signedInUser != null && (model.selected != null || model.tab != Tab.Overview || model.importReview != null)) {
        if (model.importReview != null) model.cancelImport()
        else if (model.selected != null) model.navigate(Tab.Accounts)
        else model.navigate(Tab.Overview)
    }
    Scaffold(bottomBar = {
        if (signedInUser != null) NavigationBar {
            Tab.entries.forEach { tab ->
                NavigationBarItem(selected = model.tab == tab, enabled = !model.busy, onClick = { model.navigate(tab) },
                    icon = { Text(tab.symbol) }, label = { Text(tab.label, softWrap = false) }, alwaysShowLabel = false,
                    modifier = Modifier.testTag("tab-${tab.name}").semantics { contentDescription = tab.label })
            }
        }
    }) { padding ->
        if (signedInUser == null) {
            Login(model, Modifier.padding(padding).imePadding())
        } else {
            Workspace(model, signedInUser, Modifier.padding(padding).imePadding()) { picker.launch(arrayOf("*/*")) }
        }
    }
    model.importReview?.let { review ->
        AlertDialog(onDismissRequest = model::cancelImport,
            title = { Text("Review transaction import") },
            text = { LazyColumn(Modifier.heightIn(max = 400.dp)) {
                item { Text(review.summary) }
                items(review.errors) { Status(it, true) }
                items(review.examples) { Entry(it, null) }
            } },
            dismissButton = { TextButton(onClick = model::cancelImport) { Text("Cancel") } },
            confirmButton = { Button(enabled = review.confirm && !model.busy, onClick = model::confirmImport) { Text("Import transactions") } })
    }
}

@Composable
private fun Login(model: FinanceViewModel, modifier: Modifier) {
    var password by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(30.dp))
        val field = Modifier.widthIn(max = 460.dp).fillMaxWidth()
        Heading("Finance", field)
        Text("Sign in to your Finance server.", field)
        Column(field) {
            if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            model.error?.let { Status(it, true) }
            model.notice?.let { Status(it) }
        }
        OutlinedTextField(model.server, { model.server = it }, field.testTag("server"),
            enabled = !model.busy, label = { Text("Finance server URL") }, placeholder = { Text("https://finance.example.com") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
        OutlinedTextField(model.username, { model.username = it }, field.testTag("username"),
            enabled = !model.busy, label = { Text("Username") }, singleLine = true)
        OutlinedTextField(password, { password = it }, field.testTag("password"),
            enabled = !model.busy, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
        Button(enabled = !model.busy && model.server.isNotBlank() && model.username.isNotBlank() && password.isNotEmpty(),
            modifier = field.testTag("sign-in"), onClick = {
                focus.clearFocus()
                val submitted = password
                password = ""
                model.signIn(submitted)
            }) {
            Text("Sign in")
        }
    }
}

@Composable
private fun Workspace(model: FinanceViewModel, signedInUser: String, modifier: Modifier, openFile: () -> Unit) {
    val page = model.page
    val currentTab = model.tab
    val title = page?.account?.name ?: if (model.selected != null) "Account activity" else currentTab.label
    val query = model.query.trim()
    val rows = remember(page, query, currentTab) {
        page?.rows.orEmpty().filter { query.isEmpty() || currentTab != Tab.Transactions ||
            it.title.contains(query, ignoreCase = true) || it.detail.contains(query, ignoreCase = true) || it.value.contains(query, ignoreCase = true) }
    }
    key(currentTab, model.selected) {
        LazyColumn(modifier.fillMaxSize().testTag("workspace"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                if (model.selected != null) TextButton(enabled = !model.busy, onClick = { model.navigate(Tab.Accounts) }) { Text("Back to accounts") }
                Heading(title)
                if (currentTab != Tab.Settings) TextButton(enabled = !model.busy, onClick = model::refresh) { Text("Refresh") }
            }
            if (model.busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            model.error?.let { item { Status(it, true) } }
            model.notice?.let { item { Status(it) } }
            if (currentTab == Tab.Settings) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Connection", style = MaterialTheme.typography.titleLarge)
                            Text(signedInUser)
                            Text(model.server)
                            Text("Sign out to change the server or username. The session is not saved when the app process exits.")
                            OutlinedButton(enabled = !model.busy, onClick = model::signOut) { Text("Sign out") }
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Current Version: ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleLarge)
                            Text("Update checking is unavailable: no Android release feed is configured.")
                        }
                    }
                }
            }
            if (page != null) {
                page.headline?.let { headline -> item {
                    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFF1D342B))) {
                        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(if (currentTab == Tab.Overview) "Net worth" else "Current balance", style = MaterialTheme.typography.labelLarge)
                            Text(headline, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.headlineLarge)
                            page.caption?.let { Text(it) }
                            if (page.history.size >= 2) Trend(page.history)
                        }
                    }
                } }
                if (page.account?.canImport == true) item {
                    OutlinedButton(enabled = !model.busy, onClick = openFile) { Text("Import CSV, OFX, or QFX") }
                }
                if (currentTab == Tab.Transactions) item {
                    OutlinedTextField(model.query, { model.query = it }, Modifier.fillMaxWidth(), enabled = !model.busy,
                        label = { Text("Search transactions") }, singleLine = true)
                }
                if (currentTab == Tab.Overview && rows.isNotEmpty()) item {
                    Text("Recent net-worth history", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                }
                if (rows.isEmpty()) item {
                    Text(when (currentTab) {
                        Tab.Overview -> "No net-worth history yet."
                        Tab.Accounts -> if (model.selected == null) "No accounts on this server." else "No account activity yet."
                        Tab.Transactions -> if (query.isEmpty()) "No transactions on this server." else "No matching transactions."
                        Tab.Property -> "No properties on this server."
                        Tab.Settings -> ""
                    })
                }
                items(rows) { row ->
                    Entry(row, row.account?.takeUnless { model.busy }?.let { id -> { model.navigate(Tab.Accounts, id) } })
                }
            }
        }
    }
}

@Composable
private fun Heading(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun Status(message: String, problem: Boolean = false) {
    Text(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
}

@Composable
private fun Entry(row: LedgerRow, action: (() -> Unit)?) {
    val content: @Composable ColumnScope.() -> Unit = {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(row.title, fontWeight = FontWeight.Medium)
                if (row.detail.isNotBlank()) Text(row.detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            if (row.value.isNotBlank()) Text(row.value, Modifier.widthIn(max = 120.dp), style = MaterialTheme.typography.bodyMedium)
        }
    }
    if (action == null) Card(Modifier.fillMaxWidth(), content = content)
    else Card(onClick = action, modifier = Modifier.fillMaxWidth(), content = content)
}

@Composable
private fun Trend(points: List<Double>) {
    val color = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(72.dp)) {
        val low = points.min()
        val span = points.max() - low
        fun position(index: Int) = Offset(size.width * index / points.lastIndex,
            size.height * (if (span == 0.0) 0.5f else (0.95 - 0.9 * (points[index] - low) / span).toFloat()))
        for (index in 1..points.lastIndex) drawLine(color, position(index - 1), position(index), strokeWidth = 2.dp.toPx())
    }
}
