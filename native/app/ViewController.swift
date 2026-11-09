//
//  Tab Triage app window: guided setup. Build_and_Install.command copies this over the packager's
//  ViewController.swift (the storyboard's WKWebView outlet stays the same).
//
//  The page (Main.html + Script.js) shows four setup steps. This side tells it:
//    - whether the extension is turned on in Safari (live: re-checked when the app comes to the front
//      and every 2 s while the window is visible; this asks macOS, not Safari's tabs),
//    - whether this copy is signed (unsigned copies need Safari's "Allow unsigned extensions"),
//    - the version and build number.
//  The page can ask to open Safari's extension settings, open a link, or remember a ticked step.
//

import Cocoa
import SafariServices
import Security
import WebKit

final class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// The extension's id is always the app's id + ".Extension" (set by the build script).
    private var extensionID: String { (Bundle.main.bundleIdentifier ?? "com.joshhotz.tabtriage") + ".Extension" }
    private var timer: Timer?
    private var pageReady = false
    private let stepsKey = "TabTriageSetupSteps"

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        if let page = Bundle.main.url(forResource: "Main", withExtension: "html"), let root = Bundle.main.resourceURL {
            webView.loadFileURL(page, allowingReadAccessTo: root)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(refresh),
                                               name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if let w = view.window {
            w.title = "Tab Triage"
            w.setContentSize(NSSize(width: 600, height: 700))
            w.minSize = NSSize(width: 480, height: 520)
            w.styleMask.insert(.resizable)
            w.center()
        }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self = self, self.view.window?.isVisible == true else { return }
            self.refresh()
        }
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        timer?.invalidate()
        timer = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        let info = Bundle.main.infoDictionary ?? [:]
        let saved = UserDefaults.standard.stringArray(forKey: stepsKey) ?? []
        let setup: [String: Any] = [
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "signed": Self.isSignedByDeveloper(),
            "settingsWord": ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)) ? "Settings" : "Preferences",
            "steps": saved
        ]
        send("setup", setup)
        refresh()
    }

    @objc private func refresh() {
        guard pageReady else { return }
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionID) { [weak self] state, error in
            DispatchQueue.main.async {
                // nil = Safari can't see the extension yet (not registered, or unsigned and not allowed).
                let enabled: Any = (error == nil ? state?.isEnabled : nil).map { $0 as Any } ?? NSNull()
                self?.send("state", ["enabled": enabled])
            }
        }
    }

    private func send(_ fn: String, _ value: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.TabTriageApp && window.TabTriageApp.\(fn)(\(json))", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "open-safari-settings":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionID) { _ in }
        case "open-url":
            // Only the project's own pages.
            if let s = body["url"] as? String, let url = URL(string: s), url.scheme == "https",
               url.host == "github.com" {
                NSWorkspace.shared.open(url)
            }
        case "save-steps":
            let steps = (body["steps"] as? [String] ?? []).filter { $0.count < 40 }.prefix(10)
            UserDefaults.standard.set(Array(steps), forKey: stepsKey)
        default:
            break
        }
    }

    /// True when this copy carries a real developer signature (Apple Development or Developer ID),
    /// false for unsigned or ad-hoc copies such as the prebuilt download.
    static func isSignedByDeveloper() -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess, let code = code else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return false }
        return (dict[kSecCodeInfoTeamIdentifier as String] as? String)?.isEmpty == false
    }
}
