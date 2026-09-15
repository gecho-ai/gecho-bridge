import AppKit
import Foundation
import Darwin

final class GechoTrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var menu = NSMenu()
    private var inputBuffer = ""
    private var status: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        purgeLegacyAutosavePositions()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.isVisible = true
        setupStatusItemImage()
        statusItem.menu = menu
        rebuildMenu()
        configureInput()
        send(["type": "ready"])
    }

    private func setupStatusItemImage() {
        let bundle = Bundle.main
        var trayImage: NSImage?
        if let templatePath = bundle.path(forResource: "tray-iconTemplate", ofType: "png") {
            trayImage = NSImage(contentsOfFile: templatePath)
            trayImage?.isTemplate = true
        } else if let colorPath = bundle.path(forResource: "tray-icon", ofType: "png") {
            trayImage = NSImage(contentsOfFile: colorPath)
        }

        if let image = trayImage {
            image.size = NSSize(width: 18, height: 18)
            statusItem.button?.image = image
        } else {
            let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
            let image = NSImage(systemSymbolName: "bolt.fill", accessibilityDescription: "Gecho")?.withSymbolConfiguration(config)
            image?.isTemplate = true
            statusItem.button?.image = image
        }
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "Gecho"
    }

    private func purgeLegacyAutosavePositions() {
        let defaults = UserDefaults.standard
        defaults.removePersistentDomain(forName: "ai.gecho.desktop.tray")
        let dictionary = defaults.dictionaryRepresentation()
        for key in dictionary.keys {
            if key.contains("GechoStatusItem") || (key.hasPrefix("NSStatusItem") && key.contains("Gecho")) {
                defaults.removeObject(forKey: key)
            }
        }
        defaults.synchronize()
    }

    private func configureInput() {
        let fileDescriptor = FileHandle.standardInput.fileDescriptor
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                var descriptor = pollfd(
                    fd: fileDescriptor,
                    events: Int16(POLLIN),
                    revents: 0
                )
                guard Darwin.poll(&descriptor, 1, -1) > 0 else { continue }
                if descriptor.revents & Int16(POLLHUP) != 0,
                   descriptor.revents & Int16(POLLIN) == 0 {
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                    break
                }

                let count = buffer.withUnsafeMutableBytes { bytes in
                    Darwin.read(fileDescriptor, bytes.baseAddress, bytes.count)
                }
                guard count > 0 else {
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                    break
                }
                let text = String(decoding: buffer.prefix(count), as: UTF8.self)
                DispatchQueue.main.async { [weak self] in
                    self?.inputBuffer.append(text)
                    self?.consumeInputLines()
                }
            }
        }
    }

    private func consumeInputLines() {
        while let newline = inputBuffer.firstIndex(of: "\n") {
            let line = String(inputBuffer[..<newline])
            inputBuffer.removeSubrange(...newline)
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data),
                  let message = object as? [String: Any] else { continue }

            if message["type"] as? String == "shutdown" {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                continue
            }
            if message["type"] as? String == "status" {
                status = message
                rebuildMenu()
            }
        }
    }

    private func text(_ key: String, fallback: String) -> String {
        status[key] as? String ?? fallback
    }

    private func bool(_ key: String) -> Bool {
        status[key] as? Bool ?? false
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        addDisabled("Gecho \(text("version", fallback: ""))")
        addDisabled("Bridge：\(text("serviceLabel", fallback: "启动中"))")
        addDisabled("浏览器插件：\(bool("extensionConnected") ? "已连接" : "未连接")")
        addDisabled("浏览器：\(text("browser", fallback: "—"))")
        menu.addItem(.separator())

        let openDashboard = NSMenuItem(title: "打开面板", action: #selector(openDashboardAction), keyEquivalent: "")
        openDashboard.target = self
        menu.addItem(openDashboard)

        let onboarding = NSMenuItem(title: "打开浏览器连接引导", action: #selector(openOnboarding), keyEquivalent: "")
        onboarding.target = self
        menu.addItem(onboarding)

        let dataDir = NSMenuItem(title: "打开数据目录", action: #selector(openDataDirectory), keyEquivalent: "")
        dataDir.target = self
        menu.addItem(dataDir)

        let autoStart = NSMenuItem(title: "登录时自动启动", action: #selector(toggleAutoStart(_:)), keyEquivalent: "")
        autoStart.target = self
        autoStart.state = bool("autoStart") ? .on : .off
        menu.addItem(autoStart)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 Gecho", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func addDisabled(_ title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
    }

    @objc private func openDashboardAction() {
        send(["type": "command", "command": "open-dashboard"])
    }

    @objc private func openOnboarding() {
        send(["type": "command", "command": "open-onboarding"])
    }

    @objc private func openDataDirectory() {
        send(["type": "command", "command": "open-data"])
    }

    @objc private func toggleAutoStart(_ item: NSMenuItem) {
        let enabled = item.state != .on
        item.state = enabled ? .on : .off
        send(["type": "command", "command": "toggle-autostart", "enabled": enabled])
    }

    @objc private func quit() {
        send(["type": "command", "command": "quit"])
        NSApp.terminate(nil)
    }

    private func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              var line = String(data: data, encoding: .utf8) else { return }
        line.append("\n")
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

private var strongDelegate: GechoTrayDelegate?

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = GechoTrayDelegate()
strongDelegate = delegate
app.delegate = delegate
app.run()
