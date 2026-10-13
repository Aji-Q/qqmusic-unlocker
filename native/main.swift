// QQ 音乐解锁器原生入口。
//
// 为什么不用 shell 脚本当入口：shell 脚本收不到 Apple Event，
// 一旦 Info.plist 声明了文档类型，`open -a App file.mgg` 就会把文件
// 通过 Apple Event 发过来——脚本收不到，文件就被静默丢掉了。
// 这里用 AppKit 常驻进程接住 open-documents 事件，再转发给本地服务。
//
// 编译：swiftc -O -o QQMusicUnlocker main.swift -framework AppKit

import AppKit
import Foundation

let bundlePath = Bundle.main.bundlePath
let resources = bundlePath + "/Contents/Resources"
let appDir = resources + "/app"
let home = NSHomeDirectory()
let logDir = home + "/Library/Logs/QQMusicUnlocker"
let logFile = logDir + "/launcher.log"
let runtimeFile = logDir + "/runtime.json"

var serverProcess: Process?
let environment = ProcessInfo.processInfo.environment

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    if let handle = FileHandle(forWritingAtPath: logFile) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        handle.closeFile()
    } else {
        try? line.write(toFile: logFile, atomically: true, encoding: .utf8)
    }
}

func alert(_ title: String, _ message: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = message
    a.alertStyle = .warning
    a.runModal()
}

/// 找可用的 python3
func findPython() -> String? {
    let candidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["-c", "import plistlib, sqlite3"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { continue }
        p.waitUntilExit()
        if p.terminationStatus == 0 { return path }
    }
    return nil
}

func processAlive(_ pid: Int) -> Bool {
    guard pid > 0 else { return false }
    return kill(pid_t(pid), 0) == 0
}

func runtimeInfo() -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: runtimeFile),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    guard let pid = obj["pid"] as? Int, processAlive(pid) else { return nil }
    return obj
}

func launchEnvironment() -> [String: String] {
    var env = environment
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? ""]).joined(separator: ":")
    return env
}

@discardableResult
func startServer() -> Bool {
    if runtimeInfo() != nil { return true }
    guard let python = findPython() else {
        alert("缺少 Python 3", "请先安装命令行工具：xcode-select --install")
        return false
    }
    let fm = FileManager.default
    guard let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
        .first(where: { fm.isExecutableFile(atPath: $0) }) else {
        alert("缺少 ffmpeg", "请先在终端执行：brew install ffmpeg")
        return false
    }
    _ = ffmpeg

    try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()

    let p = Process()
    p.executableURL = URL(fileURLWithPath: python)
    p.arguments = [appDir + "/server.py", "--token", token,
                   "--runtime-file", runtimeFile, "--no-browser"]
    p.environment = launchEnvironment()
    var handle = FileHandle.nullDevice
    if !fm.fileExists(atPath: logFile) { fm.createFile(atPath: logFile, contents: nil) }
    handle = FileHandle(forWritingAtPath: logFile) ?? FileHandle.nullDevice
    p.standardOutput = handle
    p.standardError = handle
    do { try p.run() } catch {
        alert("启动失败", "无法启动本地服务：\(error.localizedDescription)")
        return false
    }
    serverProcess = p
    for _ in 0..<80 {
        if runtimeInfo() != nil { return true }
        Thread.sleep(forTimeInterval: 0.25)
    }
    alert("启动失败", "服务没有起来，详见 ~/Library/Logs/QQMusicUnlocker/launcher.log")
    return false
}

func openUI() {
    guard let info = runtimeInfo(),
          let port = info["port"] as? Int,
          let token = info["token"] as? String else { return }
    guard let url = URL(string: "http://127.0.0.1:\(port)/?t=\(token)") else { return }
    let browsers = ["Google Chrome", "Microsoft Edge", "Brave Browser"]
    for name in browsers where FileManager.default.fileExists(atPath: "/Applications/\(name).app") {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", name, url.absoluteString]
        try? p.run()
        return
    }
    NSWorkspace.shared.open(url)
}

/// 把文件塞进运行中的队列
@discardableResult
func push(files: [String]) -> Bool {
    guard let info = runtimeInfo(),
          let port = info["port"] as? Int,
          let token = info["token"] as? String,
          let url = URL(string: "http://127.0.0.1:\(port)/api/open") else { return false }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(token, forHTTPHeaderField: "X-Token")
    request.timeoutInterval = 15
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["paths": files])
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
        if let http = response as? HTTPURLResponse { ok = http.statusCode == 200 }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 20)
    return ok
}

func quitServer() {
    guard let info = runtimeInfo(),
          let port = info["port"] as? Int,
          let token = info["token"] as? String,
          let url = URL(string: "http://127.0.0.1:\(port)/api/quit") else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(token, forHTTPHeaderField: "X-Token")
    request.httpBody = "{}".data(using: .utf8)
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 5)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-") }
        let files = args.filter { FileManager.default.fileExists(atPath: $0) }
        guard startServer() else { NSApp.terminate(nil); return }
        if !files.isEmpty {
            log("启动参数带入 \(files.count) 个文件")
            _ = push(files: files)
        }
        openUI()
    }

    /// Finder 里把文件拖到应用图标上 / `open -a App file` 都会走这里
    func application(_ application: NSApplication, open urls: [URL]) {
        let paths = urls.filter { $0.isFileURL }.map { $0.path }
        guard !paths.isEmpty else { return }
        log("收到 \(paths.count) 个文件（Apple Event）")
        if runtimeInfo() == nil { _ = startServer() }
        _ = push(files: paths)
        openUI()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        log("应用退出，关闭本地服务")
        quitServer()
        serverProcess?.terminate()
    }
}

let delegate = AppDelegate()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
