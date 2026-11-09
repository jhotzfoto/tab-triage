//
//  Tab Triage native handler. Build_and_Install.command copies this over the packager's echo stub.
//
//  One request, from background.js via browser.runtime.sendNativeMessage:
//    { type: "usage", cpu: Bool }  ->  Safari's memory and CPU, plus the Mac's memory and swap.
//  Read-only: lists processes and reads their size and CPU time. Writes nothing, anywhere.
//  Safari can't say which process is which tab, so everything here is Safari-wide.
//

import SafariServices
import Darwin

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        var reply: [String: Any] = ["ok": false, "error": "Unknown request"]
        if let m = message as? [String: Any], (m["type"] as? String) == "usage" {
            reply = TabTriageUsage.measure(sampleCPU: (m["cpu"] as? Bool) ?? true)
        }

        let response = NSExtensionItem()
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

enum TabTriageUsage {

    struct Proc { var memory: UInt64; var cpuNs: UInt64; var page: Bool; var shared: Bool }

    /// Safari and its own WebKit helpers. When Safari is updated apart from macOS (Big Sur to
    /// Sequoia), it runs from a cryptex (.../StagedFrameworks/Safari/...) and its WebKit processes are
    /// Safari's alone. When Safari ships with macOS itself, its WebKit processes live in
    /// /System/Library/Frameworks and are shared with other apps (Mail etc.); those count only when no
    /// staged Safari processes exist, and the reply says "shared": true.
    static func kind(_ path: String) -> (kind: String, shared: Bool)? {
        if path.hasSuffix("/Safari.app/Contents/MacOS/Safari") { return ("app", false) }
        let shared: Bool
        if path.contains("/StagedFrameworks/Safari/") { shared = false }
        else if path.hasPrefix("/System/Library/Frameworks/WebKit.framework/") { shared = true }
        else { return nil }
        if path.hasSuffix("/com.apple.WebKit.WebContent") { return ("page", shared) }
        if path.hasSuffix("/com.apple.WebKit.GPU") || path.hasSuffix("/com.apple.WebKit.Networking") { return ("helper", shared) }
        return nil
    }

    static let tickToNs: Double = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb.denom == 0 ? 1 : Double(tb.numer) / Double(tb.denom)
    }()

    /// One pass over every process. `access` records which reads the sandbox allowed.
    static func sample(_ access: inout [String: Bool]) -> [pid_t: Proc] {
        var out: [pid_t: Proc] = [:]
        let estimate = proc_listallpids(nil, 0)
        guard estimate > 0 else { return out }
        var pids = [pid_t](repeating: 0, count: Int(estimate) + 64)
        let n = pids.withUnsafeMutableBufferPointer { buf in
            proc_listallpids(buf.baseAddress, Int32(buf.count * MemoryLayout<pid_t>.size))
        }
        guard n > 0 else { return out }
        access["list"] = true
        var pathBuf = [CChar](repeating: 0, count: 4096)
        var sawStaged = false
        for pid in pids.prefix(Int(n)) where pid > 0 {
            guard proc_pidpath(pid, &pathBuf, UInt32(pathBuf.count)) > 0 else { continue }
            access["path"] = true
            guard let k = kind(String(cString: pathBuf)) else { continue }
            let isPage = k.kind == "page"
            if k.kind != "app" && !k.shared { sawStaged = true }
            var ru = rusage_info_v4()
            let rc = withUnsafeMutablePointer(to: &ru) { p in
                p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
            }
            if rc == 0 {
                access["rusage"] = true
                let ticks = Double(ru.ri_user_time &+ ru.ri_system_time)
                out[pid] = Proc(memory: ru.ri_phys_footprint, cpuNs: UInt64(ticks * tickToNs), page: isPage, shared: k.shared)
                continue
            }
            var ti = proc_taskinfo()
            let size = Int32(MemoryLayout<proc_taskinfo>.size)
            if proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, size) == size {
                access["taskinfo"] = true
                let ticks = Double(ti.pti_total_user &+ ti.pti_total_system)
                out[pid] = Proc(memory: ti.pti_resident_size, cpuNs: UInt64(ticks * tickToNs), page: isPage, shared: k.shared)
            }
        }
        // Staged (Safari-only) WebKit processes found: drop the shared system ones.
        if sawStaged { out = out.filter { !$0.value.shared } }
        return out
    }

    /// The Mac as a whole: memory used (Activity Monitor's definition), RAM, swap, pressure.
    static func mac() -> [String: Any] {
        var info: [String: Any] = ["ramTotal": Double(ProcessInfo.processInfo.physicalMemory)]
        var vm = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &vm) { p in
            p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        if kr == KERN_SUCCESS {
            var page: vm_size_t = 0
            host_page_size(mach_host_self(), &page)
            // App memory (internal - purgeable) + wired + compressed.
            let app = UInt64(vm.internal_page_count) &- min(UInt64(vm.purgeable_count), UInt64(vm.internal_page_count))
            let pages = app + UInt64(vm.wire_count) + UInt64(vm.compressor_page_count)
            info["ramUsed"] = Double(pages) * Double(page)
        }
        var swap = xsw_usage()
        var swapSize = MemoryLayout<xsw_usage>.size
        if sysctlbyname("vm.swapusage", &swap, &swapSize, nil, 0) == 0 {
            info["swapUsed"] = Double(swap.xsu_used)
            info["swapTotal"] = Double(swap.xsu_total)
        }
        var level: Int32 = 0
        var levelSize = MemoryLayout<Int32>.size
        if sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &levelSize, nil, 0) == 0 {
            info["pressure"] = level == 4 ? "critical" : level == 2 ? "warning" : "normal"
        }
        return info
    }

    static func measure(sampleCPU: Bool) -> [String: Any] {
        var access: [String: Bool] = ["list": false, "path": false, "rusage": false, "taskinfo": false]
        let t0 = DispatchTime.now().uptimeNanoseconds
        let first = sample(&access)
        var result: [String: Any] = [
            "ok": true, "v": 1, "at": Date().timeIntervalSince1970 * 1000, "mac": mac()
        ]
        guard !first.isEmpty else {
            result["safari"] = NSNull()
            result["error"] = access["path"] == true
                ? "Safari isn't running, or its processes aren't readable."
                : "macOS doesn't let the extension read other processes."
            result["access"] = access
            return result
        }
        var safari: [String: Any] = [
            "memory": Double(first.values.reduce(0) { $0 + $1.memory }),
            "processes": first.count,
            "pages": first.values.filter { $0.page }.count,
            "footprint": access["rusage"] == true,
            "shared": first.values.contains { $0.shared }
        ]
        if sampleCPU {
            Thread.sleep(forTimeInterval: 1.0)
            let second = sample(&access)
            let wall = Double(DispatchTime.now().uptimeNanoseconds - t0)
            var busy: Double = 0
            for (pid, b) in second { if let a = first[pid], b.cpuNs >= a.cpuNs { busy += Double(b.cpuNs - a.cpuNs) } }
            safari["cpu"] = wall > 0 ? (busy / wall * 100).rounded() : 0
        }
        result["safari"] = safari
        result["access"] = access
        return result
    }
}
