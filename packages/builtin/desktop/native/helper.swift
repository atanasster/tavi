import ApplicationServices
import AppKit
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

/// Tavi macOS desktop perception and input helper (`@tavi/plugin-desktop`).
/// Speaks newline-delimited JSON (NDJSON) over stdin/stdout with a `ready` handshake.
///
/// Requests run one at a time on a serial queue; the main thread runs the event tap that
/// consumes the abort hotkey (`--abort-hotkey cmd+shift+escape` by default) and reports
/// it as `{"type":"abort"}`. A `cancel` request is handled on arrival, never queued.

private let axMessagingTimeoutSeconds: Float = 2.0
private let minDragSteps: Int = 12
private let defaultAbortHotkey = "cmd+shift+escape"

struct HelperError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

struct BridgeRequest: Decodable {
  let id: String
  let method: String
  let params: [String: AnyCodable]?
}

struct AnyCodable: Decodable {
  let value: Any

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let str = try? container.decode(String.self) {
      self.value = str
    } else if let intVal = try? container.decode(Int.self) {
      self.value = intVal
    } else if let doubleVal = try? container.decode(Double.self) {
      self.value = doubleVal
    } else if let boolVal = try? container.decode(Bool.self) {
      self.value = boolVal
    } else if let arr = try? container.decode([AnyCodable].self) {
      self.value = arr.map(\.value)
    } else if let dict = try? container.decode([String: AnyCodable].self) {
      self.value = dict.mapValues(\.value)
    } else {
      self.value = NSNull()
    }
  }
}

private let stdoutLock = NSLock()

func writeJsonLine(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
        let line = String(data: data, encoding: .utf8) else {
    return
  }
  stdoutLock.lock()
  defer { stdoutLock.unlock() }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// A lock-guarded counter or flag, safe to read from the event tap, the reader thread and the request queue.
final class Guarded<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) {
    self.value = value
  }

  func update(_ change: (inout Value) -> Void) {
    lock.lock()
    change(&value)
    lock.unlock()
  }

  var current: Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// Moved by the abort hotkey or a `cancel` request. Each request is stamped with the generation it
/// was queued under: one queued before the latest abort is refused, and typing stops when it moves.
private let abortGeneration = Guarded<UInt64>(0)

func raiseAbort() {
  abortGeneration.update { $0 &+= 1 }
}

func isAborted(since generation: UInt64) -> Bool {
  abortGeneration.current != generation
}

/// Set when stdin closes: requests still queued are dropped, never run.
private let stdinClosed = Guarded<Bool>(false)

/// Where the event tap hands its abort line, so the tap never waits on a large stdout write.
private let eventQueue = DispatchQueue(label: "ai.tavi.desktop-helper.events")

// MARK: - The processes Tavi runs in

func parentPid(of pid: pid_t) -> pid_t? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else {
    return nil
  }
  return info.kp_eproc.e_ppid
}

/// The helper's ancestors (node, the shell, the terminal that runs tavi), by walking the parent PID chain.
func ancestorPids() -> Set<pid_t> {
  var result = Set<pid_t>()
  var current = getppid()
  while current > 1, !result.contains(current) {
    result.insert(current)
    guard let next = parentPid(of: current) else { break }
    current = next
  }
  return result
}

private let taviHostPids = ancestorPids()

/// The app that launched the shell running Tavi, as macOS records it in `__CFBundleIdentifier`. Under tmux or
/// screen the terminal showing Tavi is not in the parent chain, but its bundle id is still inherited.
private let taviHostBundleId: String? = {
  let value = ProcessInfo.processInfo.environment["__CFBundleIdentifier"]?.trimmingCharacters(in: .whitespaces).lowercased()
  return value?.isEmpty == false ? value : nil
}()

func isTaviHostBundle(_ bundleId: String?) -> Bool {
  guard let host = taviHostBundleId, let bundleId = bundleId else { return false }
  return bundleId.lowercased() == host
}

func isTaviHost(_ pid: pid_t) -> Bool {
  if taviHostPids.contains(pid) { return true }
  return taviHostBundleId != nil && isTaviHostBundle(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier)
}

// MARK: - Accessibility

func configureMessagingTimeout(_ element: AXUIElement) {
  AXUIElementSetMessagingTimeout(element, axMessagingTimeoutSeconds)
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  var ref: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &ref)
  guard err == .success, let value = ref else { return nil }
  if let str = value as? String, !str.isEmpty {
    return str
  }
  return nil
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  var ref: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &ref)
  guard err == .success, let value = ref as? Bool else { return nil }
  return value
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success,
        let value = ref,
        CFGetTypeID(value) == AXUIElementGetTypeID() else {
    return nil
  }
  return (value as! AXUIElement)
}

func axBounds(_ element: AXUIElement) -> [String: Double]? {
  var posRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
        let posVal = posRef,
        let sizeVal = sizeRef else {
    return nil
  }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(posVal as! AXValue, .cgPoint, &point),
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size) else {
    return nil
  }
  return [
    "x": Double(point.x),
    "y": Double(point.y),
    "width": Double(size.width),
    "height": Double(size.height),
  ]
}

func serializeElement(_ element: AXUIElement, refCounter: inout Int, depth: Int, maxDepth: Int) -> [String: Any] {
  configureMessagingTimeout(element)
  let ref = "ax-\(refCounter)"
  refCounter += 1

  let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
  var node: [String: Any] = [
    "ref": ref,
    "role": role,
  ]
  if let subrole = axString(element, kAXSubroleAttribute) {
    node["subrole"] = subrole
  }
  if let title = axString(element, kAXTitleAttribute) {
    node["title"] = title
  }
  if node["subrole"] as? String != "AXSecureTextField" && role != "AXSecureTextField",
     let value = axString(element, kAXValueAttribute) {
    node["value"] = String(value.prefix(240))
  }
  if let desc = axString(element, kAXDescriptionAttribute) {
    node["description"] = desc
  }
  if let bounds = axBounds(element) {
    node["bounds"] = bounds
  }
  if let enabled = axBool(element, kAXEnabledAttribute) {
    node["enabled"] = enabled
  }
  if let focused = axBool(element, kAXFocusedAttribute) {
    node["focused"] = focused
  }

  if depth < maxDepth {
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
       let children = childrenRef as? [AXUIElement], !children.isEmpty {
      node["children"] = children.prefix(64).map {
        serializeElement($0, refCounter: &refCounter, depth: depth + 1, maxDepth: maxDepth)
      }
    }
  }
  return node
}

func resolveElementInfo(_ element: AXUIElement) -> [String: Any]? {
  configureMessagingTimeout(element)
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success,
        let runningApp = NSRunningApplication(processIdentifier: pid) else {
    return nil
  }
  let bundleId = runningApp.bundleIdentifier ?? ""
  let appName = runningApp.localizedName ?? ""
  guard !bundleId.isEmpty || !appName.isEmpty else {
    return nil
  }

  let appElement = AXUIElementCreateApplication(pid)
  configureMessagingTimeout(appElement)
  var windowTitle: String?
  if let win = axElement(appElement, kAXFocusedWindowAttribute) {
    windowTitle = axString(win, kAXTitleAttribute)
  }

  var result: [String: Any] = [
    "app": [
      "bundleId": bundleId,
      "name": appName,
      "pid": Int(pid),
      "active": runningApp.isActive,
    ],
    "role": axString(element, kAXRoleAttribute) ?? "AXUnknown",
  ]
  if let windowTitle = windowTitle {
    result["windowTitle"] = windowTitle
  }
  if let subrole = axString(element, kAXSubroleAttribute) {
    result["subrole"] = subrole
  }
  if let title = axString(element, kAXTitleAttribute) {
    result["title"] = title
  }
  if result["subrole"] as? String != "AXSecureTextField" && result["role"] as? String != "AXSecureTextField",
     let value = axString(element, kAXValueAttribute) {
    result["value"] = String(value.prefix(240))
  }
  if let bounds = axBounds(element) {
    result["bounds"] = bounds
  }
  if let enabled = axBool(element, kAXEnabledAttribute) {
    result["enabled"] = enabled
  }
  if let focused = axBool(element, kAXFocusedAttribute) {
    result["focused"] = focused
  }
  return result
}

func hitTest(x: Double, y: Double) -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  configureMessagingTimeout(systemWide)
  var hitRef: AXUIElement?
  let err = AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &hitRef)
  guard err == .success else { return nil }
  return hitRef
}

func getElementAtPoint(x: Double, y: Double) -> [String: Any]? {
  guard let element = hitTest(x: x, y: y) else {
    return nil
  }
  return resolveElementInfo(element)
}

func systemFocusedElement() -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  configureMessagingTimeout(systemWide)
  return axElement(systemWide, kAXFocusedUIElementAttribute)
}

func getFocusedElement() -> [String: Any]? {
  guard let element = systemFocusedElement() else {
    return nil
  }
  return resolveElementInfo(element)
}

/// Refuses a pointer action whose hit-tested element belongs to the terminal (or other process) that runs Tavi.
func refuseTaviHostAt(x: Double, y: Double) throws {
  guard let element = hitTest(x: x, y: y) else { return }
  var pid: pid_t = 0
  if AXUIElementGetPid(element, &pid) == .success, isTaviHost(pid) {
    throw HelperError(message: "Refused: the element at (\(Int(x)), \(Int(y))) belongs to the process that runs Tavi (pid \(pid)). Do not retry.")
  }
}

/// Refuses keyboard input while the focused element (or the frontmost app) is the process that runs Tavi.
func refuseTaviHostFocused() throws {
  var pid: pid_t = 0
  if let element = systemFocusedElement(), AXUIElementGetPid(element, &pid) == .success {
    // Resolved from the focused element.
  } else if let front = NSWorkspace.shared.frontmostApplication {
    pid = front.processIdentifier
  }
  if pid > 0, isTaviHost(pid) {
    throw HelperError(message: "Refused: keyboard focus is in the process that runs Tavi (pid \(pid)). Do not retry.")
  }
}

// MARK: - Keyboard

/// ANSI US virtual key codes, by lowercased name.
private let keyCodes: [String: CGKeyCode] = {
  var map: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, " ": 49,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "del": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "help": 114,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "minus": 27, "equal": 24, "equals": 24, "bracketleft": 33, "leftbracket": 33,
    "bracketright": 30, "rightbracket": 30, "backslash": 42, "semicolon": 41,
    "quote": 39, "apostrophe": 39, "comma": 43, "period": 47, "slash": 44,
    "grave": 50, "backquote": 50, "backtick": 50,
    "cmd": 55, "command": 55, "meta": 55, "shift": 56, "capslock": 57,
    "alt": 58, "option": 58, "ctrl": 59, "control": 59, "fn": 63,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
  ]
  map["keypadenter"] = 76
  return map
}()

/// The virtual key code for a key name (`"c"`, `"Return"`, `"page_up"`, `"F5"`, `"ArrowLeft"`), or `nil` for an unknown name.
func keyCodeForName(_ name: String) -> CGKeyCode? {
  if name.count == 1 {
    return keyCodes[name.lowercased()]
  }
  let normalized = name.lowercased().filter { $0 != " " && $0 != "_" && $0 != "-" }
  return keyCodes[normalized]
}

func requireKeyCode(_ name: String) throws -> CGKeyCode {
  guard let code = keyCodeForName(name) else {
    throw HelperError(message: "Unknown key name '\(name)'. Do not retry with the same name.")
  }
  return code
}

/// The event flags and modifier key codes for modifier names; an unknown name is an error.
func modifierSpec(_ modifiers: [String]) throws -> (flags: CGEventFlags, keyCodes: [CGKeyCode]) {
  var flags = CGEventFlags()
  var codes: [CGKeyCode] = []
  for mod in modifiers {
    switch mod.lowercased() {
    case "cmd", "command", "meta", "super":
      flags.insert(.maskCommand)
      codes.append(55)
    case "shift":
      flags.insert(.maskShift)
      codes.append(56)
    case "alt", "option":
      flags.insert(.maskAlternate)
      codes.append(58)
    case "ctrl", "control":
      flags.insert(.maskControl)
      codes.append(59)
    default:
      throw HelperError(message: "Unknown modifier '\(mod)'. Do not retry with the same name.")
    }
  }
  return (flags, codes)
}

/// How many characters are typed between checks that keyboard focus has not moved into Tavi's own processes.
private let typingFocusCheckInterval = 16

/// Types text directly as Unicode CGEvents, never touching NSPasteboard / the system clipboard.
/// Each event carries one whole character, so a surrogate pair (a character outside the BMP) is never split.
/// Typing stops when the abort generation moves, or when focus moves into the processes that run Tavi.
func typeUnicodeText(_ text: String, generation: UInt64) throws -> Int {
  guard let source = CGEventSource(stateID: .hidSystemState) else {
    throw HelperError(message: "Could not create a keyboard event source")
  }
  var typed = 0
  for character in text {
    if isAborted(since: generation) {
      throw HelperError(message: "Typing aborted after \(typed) characters")
    }
    if typed % typingFocusCheckInterval == 0 {
      try refuseTaviHostFocused()
    }
    let units = Array(String(character).utf16)
    // A CGEvent carries at most 20 UTF-16 units; a longer cluster goes one scalar at a time.
    let chunks: [[UniChar]] = units.count <= 20 ? [units] : character.unicodeScalars.map { Array(String($0).utf16) }
    for var chunk in chunks {
      if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
         let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
      }
    }
    typed += 1
  }
  return typed
}

/// Presses a key with optional modifiers, guaranteeing modifier key-up in a `defer` block.
func pressKeyWithModifiers(keyCode: CGKeyCode, modifiers: [String]) throws {
  let spec = try modifierSpec(modifiers)
  guard let source = CGEventSource(stateID: .hidSystemState) else {
    throw HelperError(message: "Could not create a keyboard event source")
  }

  for modCode in spec.keyCodes {
    CGEvent(keyboardEventSource: source, virtualKey: modCode, keyDown: true)?.post(tap: .cghidEventTap)
  }
  defer {
    for modCode in spec.keyCodes.reversed() {
      if let modUp = CGEvent(keyboardEventSource: source, virtualKey: modCode, keyDown: false) {
        modUp.flags = []
        modUp.post(tap: .cghidEventTap)
      }
    }
  }

  if let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
     let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
    down.flags = spec.flags
    up.flags = spec.flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }
}

// MARK: - Pointer

struct MouseButtonSpec {
  let down: CGEventType
  let up: CGEventType
  let dragged: CGEventType
  let button: CGMouseButton
}

/// The button a `mouse_down` holds until its `mouse_up`: moves meanwhile drag it. Touched only on the request queue.
var heldMouseButton: (button: CGMouseButton, dragged: CGEventType)? = nil

func mouseButtonSpec(_ name: String) throws -> MouseButtonSpec {
  switch name.lowercased() {
  case "left":
    return MouseButtonSpec(down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged, button: .left)
  case "right":
    return MouseButtonSpec(down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged, button: .right)
  case "middle":
    return MouseButtonSpec(down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged, button: .center)
  default:
    throw HelperError(message: "Unknown mouse button '\(name)'")
  }
}

func postMouseEvent(
  type: CGEventType,
  x: Double,
  y: Double,
  button: CGMouseButton = .left,
  clickCount: Int = 1,
  flags: CGEventFlags = []
) {
  guard let source = CGEventSource(stateID: .hidSystemState),
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button) else {
    return
  }
  event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
  event.flags = flags
  event.post(tap: .cghidEventTap)
}

/// Clicks `clickCount` times, each press carrying its click state (1, 2, 3) so a double or triple click registers.
func performClick(x: Double, y: Double, button: MouseButtonSpec, clickCount: Int, flags: CGEventFlags) {
  for state in 1...max(1, min(3, clickCount)) {
    postMouseEvent(type: button.down, x: x, y: y, button: button.button, clickCount: state, flags: flags)
    postMouseEvent(type: button.up, x: x, y: y, button: button.button, clickCount: state, flags: flags)
  }
}

/// Interpolates a drag across at least 12 CGEvent mouse-dragged steps.
func performInterpolatedDrag(fromX: Double, fromY: Double, toX: Double, toY: Double, requestedSteps: Int = minDragSteps) {
  guard let source = CGEventSource(stateID: .hidSystemState) else { return }
  let steps = max(minDragSteps, requestedSteps)
  let start = CGPoint(x: fromX, y: fromY)
  let end = CGPoint(x: toX, y: toY)

  CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  defer {
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)?
      .post(tap: .cghidEventTap)
  }

  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let pt = CGPoint(
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t
    )
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: pt, mouseButton: .left)?
      .post(tap: .cghidEventTap)
  }
}

func postScrollEvent(x: Double, y: Double, dx: Int32, dy: Int32) {
  postMouseEvent(type: .mouseMoved, x: x, y: y)
  guard let source = CGEventSource(stateID: .hidSystemState),
        let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else {
    return
  }
  event.post(tap: .cghidEventTap)
}

// MARK: - Capture

func matchesApp(_ app: NSRunningApplication, _ query: String) -> Bool {
  let lowered = query.lowercased()
  return app.bundleIdentifier?.lowercased() == lowered || app.localizedName?.lowercased() == lowered
}

func intersectionArea(_ a: CGRect, _ b: CGRect) -> CGFloat {
  let r = a.intersection(b)
  return r.isNull ? 0 : r.width * r.height
}

/// Captures through ScreenCaptureKit with an allowlist filter: a display shows only the windows of the
/// granted apps the request names (`includeBundleIds`), an app target only that app's windows. Blocked
/// apps (`excludeBundleIds`) and the processes that run Tavi are never included.
@available(macOS 14.0, *)
func captureScreen(
  target: [String: Any],
  maxWidth: Int,
  quality: Double,
  includeBundleIds: Set<String>,
  excludeBundleIds: Set<String>
) async throws -> [String: Any] {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard !content.displays.isEmpty else {
    throw HelperError(message: "No display found")
  }

  let kind = (target["kind"] as? String) ?? "display"
  let display: SCDisplay
  let filter: SCContentFilter
  var appInfo: [String: Any]?

  if kind == "app" {
    let query = (target["app"] as? String) ?? ""
    guard !query.isEmpty,
          let running = NSWorkspace.shared.runningApplications.first(where: { matchesApp($0, query) }) else {
      throw HelperError(message: "Application '\(query)' is not running")
    }
    let pid = running.processIdentifier
    let bundleId = running.bundleIdentifier?.lowercased() ?? ""
    if isTaviHost(pid) {
      throw HelperError(message: "Refused: '\(query)' is the process that runs Tavi. Do not retry.")
    }
    if bundleId.isEmpty {
      throw HelperError(message: "Refused: '\(query)' has no bundle id, so its grant cannot be checked. Do not retry.")
    }
    if excludeBundleIds.contains(bundleId) || !includeBundleIds.contains(bundleId) {
      throw HelperError(message: "Refused: '\(query)' is not a granted application for capture. Do not retry.")
    }
    let windows = content.windows.filter { $0.owningApplication?.processID == pid }
    guard !windows.isEmpty else {
      throw HelperError(message: "Application '\(query)' has no on-screen windows")
    }
    // The display that shows most of the app's windows.
    var best = content.displays[0]
    var bestArea: CGFloat = -1
    for candidate in content.displays {
      let bounds = CGDisplayBounds(candidate.displayID)
      let area = windows.reduce(CGFloat(0)) { $0 + intersectionArea($1.frame, bounds) }
      if area > bestArea {
        best = candidate
        bestArea = area
      }
    }
    display = best
    filter = SCContentFilter(display: display, including: windows)
    appInfo = [
      "bundleId": running.bundleIdentifier ?? "",
      "name": running.localizedName ?? "",
      "pid": Int(pid),
      "active": running.isActive,
    ]
  } else {
    let rawId: Double? = (target["displayId"] as? Int).map(Double.init) ?? (target["displayId"] as? Double)
    var requestedId: CGDirectDisplayID?
    if let rawId = rawId {
      guard rawId.isFinite, rawId >= 0, rawId <= Double(UInt32.max), rawId == rawId.rounded() else {
        throw HelperError(message: "Invalid displayId")
      }
      requestedId = CGDirectDisplayID(rawId)
    }
    if let requestedId = requestedId {
      guard let found = content.displays.first(where: { $0.displayID == requestedId }) else {
        throw HelperError(message: "Display \(requestedId) not found")
      }
      display = found
    } else {
      let mainId = CGMainDisplayID()
      display = content.displays.first(where: { $0.displayID == mainId }) ?? content.displays[0]
    }
    let apps = content.applications.filter { app in
      let bundleId = app.bundleIdentifier.lowercased()
      return !bundleId.isEmpty
        && includeBundleIds.contains(bundleId)
        && !excludeBundleIds.contains(bundleId)
        && !isTaviHostBundle(bundleId)
        && !isTaviHost(app.processID)
    }
    guard !apps.isEmpty else {
      throw HelperError(message: "No granted application is on screen to capture")
    }
    filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
  }

  let logicalWidth = max(1, display.width)
  let logicalHeight = max(1, display.height)
  let targetWidth = min(logicalWidth, max(160, maxWidth))
  let targetHeight = max(1, Int(round(Double(logicalHeight) * Double(targetWidth) / Double(logicalWidth))))

  let config = SCStreamConfiguration()
  config.width = targetWidth
  config.height = targetHeight
  config.showsCursor = false

  let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  let rep = NSBitmapImageRep(cgImage: cgImage)
  let compression = min(1.0, max(0.05, quality / 100.0))
  guard let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: compression]) else {
    throw HelperError(message: "JPEG encoding failed")
  }

  var result: [String: Any] = [
    "data": jpegData.base64EncodedString(),
    "mediaType": "image/jpeg",
    "scale": [
      "logicalWidth": logicalWidth,
      "logicalHeight": logicalHeight,
      "imageWidth": targetWidth,
      "imageHeight": targetHeight,
    ],
  ]
  if let appInfo = appInfo {
    result["app"] = appInfo
  }
  return result
}

// MARK: - Apps and trees

func listApps() -> [[String: Any]] {
  var results: [[String: Any]] = []
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    let bundleId = app.bundleIdentifier ?? ""
    let name = app.localizedName ?? ""
    guard !bundleId.isEmpty || !name.isEmpty else { continue }
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    configureMessagingTimeout(appEl)
    var winTitle: String?
    if let win = axElement(appEl, kAXFocusedWindowAttribute) {
      winTitle = axString(win, kAXTitleAttribute)
    }
    var item: [String: Any] = [
      "bundleId": bundleId,
      "name": name,
      "pid": Int(app.processIdentifier),
      "active": app.isActive,
      "hidden": app.isHidden,
    ]
    if let winTitle = winTitle {
      item["windowTitle"] = winTitle
    }
    results.append(item)
  }
  return results
}

func getTree(appQuery: String) -> [String: Any] {
  guard let runningApp = NSWorkspace.shared.runningApplications.first(where: { matchesApp($0, appQuery) }) else {
    return [
      "app": ["bundleId": appQuery, "name": appQuery, "pid": 0, "active": false],
      "nodes": [],
    ]
  }
  let pid = runningApp.processIdentifier
  let appEl = AXUIElementCreateApplication(pid)
  configureMessagingTimeout(appEl)
  var refCounter = 0
  var nodes: [[String: Any]] = []
  var windowsRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef) == .success,
     let windows = windowsRef as? [AXUIElement] {
    for win in windows.prefix(8) {
      nodes.append(serializeElement(win, refCounter: &refCounter, depth: 0, maxDepth: 5))
    }
  }
  var winTitle: String?
  if let win = axElement(appEl, kAXFocusedWindowAttribute) {
    winTitle = axString(win, kAXTitleAttribute)
  }
  var result: [String: Any] = [
    "app": [
      "bundleId": runningApp.bundleIdentifier ?? appQuery,
      "name": runningApp.localizedName ?? appQuery,
      "pid": Int(pid),
      "active": runningApp.isActive,
    ],
    "nodes": nodes,
  ]
  if let winTitle = winTitle {
    result["windowTitle"] = winTitle
  }
  // The app's own focused element, never the system-wide one: that can belong to another app.
  if let focused = axElement(appEl, kAXFocusedUIElementAttribute) {
    var focusedPid: pid_t = 0
    if AXUIElementGetPid(focused, &focusedPid) == .success, focusedPid == pid,
       let info = resolveElementInfo(focused) {
      result["focused"] = info
    }
  }
  return result
}

// MARK: - Requests

/// A finite number from the request, clamped to `range`; an absent value is `fallback`, a non-number or
/// non-finite value is an error. Converting out-of-range doubles to integers would trap, so nothing reaches
/// an integer conversion unclamped.
func numParam(
  _ params: [String: AnyCodable]?,
  _ key: String,
  default fallback: Double = 0,
  range: ClosedRange<Double> = -100_000...100_000
) throws -> Double {
  guard let raw = params?[key]?.value, !(raw is NSNull) else { return fallback }
  let value: Double
  if let d = raw as? Double {
    value = d
  } else if let i = raw as? Int {
    value = Double(i)
  } else {
    throw HelperError(message: "Parameter '\(key)' must be a number")
  }
  guard value.isFinite else {
    throw HelperError(message: "Parameter '\(key)' must be finite")
  }
  return min(range.upperBound, max(range.lowerBound, value))
}

func intParam(_ params: [String: AnyCodable]?, _ key: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
  let value = try numParam(params, key, default: Double(fallback), range: Double(range.lowerBound)...Double(range.upperBound))
  return Int(value.rounded())
}

func stringListParam(_ params: [String: AnyCodable]?, _ key: String) -> [String] {
  (params?[key]?.value as? [Any])?.compactMap { $0 as? String } ?? []
}

/// Scroll deltas, in pixels, are bounded so a wild value cannot overflow the event's 32-bit wheel fields.
private let scrollDeltaRange = -10_000...10_000

func handleRequest(_ req: BridgeRequest, generation: UInt64) throws -> Any {
  let params = req.params
  switch req.method {
  case "list_apps":
    return listApps()
  case "get_tree":
    return getTree(appQuery: (params?["app"]?.value as? String) ?? "")
  case "get_element_at_point":
    return getElementAtPoint(x: try numParam(params, "x"), y: try numParam(params, "y")) ?? NSNull()
  case "get_focused_element":
    return getFocusedElement() ?? NSNull()
  case "type_text":
    let text = (params?["text"]?.value as? String) ?? ""
    return ["typed": try typeUnicodeText(text, generation: generation)]
  case "press_key":
    let keyName = (params?["key"]?.value as? String) ?? ""
    let keyCode = try requireKeyCode(keyName)
    try refuseTaviHostFocused()
    try pressKeyWithModifiers(keyCode: keyCode, modifiers: stringListParam(params, "modifiers"))
    return ["pressed": keyName]
  case "key_down", "key_up":
    let keyName = (params?["key"]?.value as? String) ?? ""
    let keyCode = try requireKeyCode(keyName)
    if req.method == "key_down" {
      try refuseTaviHostFocused()
    }
    if let source = CGEventSource(stateID: .hidSystemState),
       let ev = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: req.method == "key_down") {
      ev.post(tap: .cghidEventTap)
    }
    return ["ok": true]
  case "click":
    let x = try numParam(params, "x")
    let y = try numParam(params, "y")
    let button = try mouseButtonSpec((params?["button"]?.value as? String) ?? "left")
    let flags = try modifierSpec(stringListParam(params, "modifiers")).flags
    let clickCount = try intParam(params, "clickCount", default: 1, range: 1...3)
    try refuseTaviHostAt(x: x, y: y)
    performClick(x: x, y: y, button: button, clickCount: clickCount, flags: flags)
    return ["clicked": true]
  case "move":
    // With a button held (mouse_down), a move is that button's drag, which apps read as one.
    let moveX = try numParam(params, "x")
    let moveY = try numParam(params, "y")
    if let held = heldMouseButton {
      postMouseEvent(type: held.dragged, x: moveX, y: moveY, button: held.button)
    } else {
      postMouseEvent(type: .mouseMoved, x: moveX, y: moveY)
    }
    return ["moved": true]
  case "mouse_down", "mouse_up":
    let x = try numParam(params, "x")
    let y = try numParam(params, "y")
    let button = try mouseButtonSpec((params?["button"]?.value as? String) ?? "left")
    let down = req.method == "mouse_down"
    // A release is never refused: a button left down would drag whatever comes next.
    if down { try refuseTaviHostAt(x: x, y: y) }
    postMouseEvent(type: down ? button.down : button.up, x: x, y: y, button: button.button)
    heldMouseButton = down ? (button: button.button, dragged: button.dragged) : nil
    return down ? ["down": true] : ["up": true]
  case "scroll":
    let x = try numParam(params, "x")
    let y = try numParam(params, "y")
    let dx = try intParam(params, "dx", default: 0, range: scrollDeltaRange)
    let dy = try intParam(params, "dy", default: 0, range: scrollDeltaRange)
    try refuseTaviHostAt(x: x, y: y)
    postScrollEvent(x: x, y: y, dx: Int32(dx), dy: Int32(dy))
    return ["scrolled": true]
  case "drag":
    let fromX = try numParam(params, "fromX")
    let fromY = try numParam(params, "fromY")
    let toX = try numParam(params, "toX")
    let toY = try numParam(params, "toY")
    let steps = try intParam(params, "steps", default: minDragSteps, range: 1...100)
    try refuseTaviHostAt(x: fromX, y: fromY)
    try refuseTaviHostAt(x: toX, y: toY)
    performInterpolatedDrag(fromX: fromX, fromY: fromY, toX: toX, toY: toY, requestedSteps: steps)
    return ["dragged": true]
  case "capture":
    guard #available(macOS 14.0, *) else {
      throw HelperError(message: "ScreenCaptureKit screenshot requires macOS 14.0 or newer")
    }
    let target = (params?["target"]?.value as? [String: Any]) ?? ["kind": "display"]
    let maxWidth = try intParam(params, "maxWidth", default: 1280, range: 160...8192)
    let quality = try numParam(params, "quality", default: 72, range: 0...100)
    let included = Set(stringListParam(params, "includeBundleIds").map { $0.lowercased() })
    let excluded = Set(stringListParam(params, "excludeBundleIds").map { $0.lowercased() })
    let sem = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var outcome: Result<[String: Any], Error> = .failure(HelperError(message: "Capture did not finish"))
    Task {
      do {
        outcome = .success(try await captureScreen(
          target: target,
          maxWidth: maxWidth,
          quality: quality,
          includeBundleIds: included,
          excludeBundleIds: excluded
        ))
      } catch {
        outcome = .failure(error)
      }
      sem.signal()
    }
    sem.wait()
    return try outcome.get()
  default:
    throw HelperError(message: "Unknown method: \(req.method)")
  }
}

/// Runs one queued request: refused unrun when an abort came after it was queued, dropped when stdin has closed.
func runQueuedRequest(_ req: BridgeRequest, generation: UInt64) {
  if stdinClosed.current { return }
  if isAborted(since: generation) {
    writeJsonLine(["id": req.id, "ok": false, "error": "Request '\(req.method)' aborted before it ran"])
    return
  }
  do {
    writeJsonLine(["id": req.id, "ok": true, "result": try handleRequest(req, generation: generation)])
  } catch {
    writeJsonLine(["id": req.id, "ok": false, "error": error.localizedDescription])
  }
}

// MARK: - Abort hotkey

struct AbortHotkey {
  let combo: String
  let keyCode: CGKeyCode
  let flags: CGEventFlags
}

func parseAbortHotkey(_ combo: String) throws -> AbortHotkey {
  let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
  guard let keyName = parts.last, !keyName.isEmpty else {
    throw HelperError(message: "Empty abort hotkey")
  }
  let keyCode = try requireKeyCode(keyName)
  let flags = try modifierSpec(Array(parts.dropLast())).flags
  guard !flags.isEmpty else {
    throw HelperError(message: "The abort hotkey needs at least one modifier")
  }
  return AbortHotkey(combo: combo, keyCode: keyCode, flags: flags)
}

private let comparedModifierFlags: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]
nonisolated(unsafe) private var abortHotkey: AbortHotkey?
nonisolated(unsafe) private var abortTap: CFMachPort?
nonisolated(unsafe) private var swallowAbortKeyUp = false

/// Consumes the abort hotkey (and its key-up) from the session event stream and reports it on stdout.
/// Events this helper posts itself pass through, so a typed or pressed combo never aborts.
private let abortTapCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = abortTap {
      CGEvent.tapEnable(tap: tap, enable: true)
    }
    return Unmanaged.passUnretained(event)
  }
  guard let hotkey = abortHotkey,
        event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()),
        CGKeyCode(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode)) == hotkey.keyCode else {
    return Unmanaged.passUnretained(event)
  }
  if type == .keyDown, event.flags.intersection(comparedModifierFlags) == hotkey.flags {
    swallowAbortKeyUp = true
    if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
      // The tap only moves the generation: the line is written elsewhere, so keyboard input never waits on stdout.
      raiseAbort()
      eventQueue.async { writeJsonLine(["type": "abort"]) }
    }
    return nil
  }
  if type == .keyUp, swallowAbortKeyUp {
    swallowAbortKeyUp = false
    return nil
  }
  return Unmanaged.passUnretained(event)
}

/// Installs the abort tap on the main run loop; returns the ready message's `abortHotkey` status.
func installAbortTap(combo: String) -> [String: Any] {
  var status: [String: Any] = ["combo": combo, "active": false]
  let hotkey: AbortHotkey
  do {
    hotkey = try parseAbortHotkey(combo)
  } catch {
    status["error"] = error.localizedDescription
    return status
  }
  abortHotkey = hotkey
  let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
  guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: mask,
    callback: abortTapCallback,
    userInfo: nil
  ) else {
    status["error"] = AXIsProcessTrusted()
      ? "The abort hotkey event tap could not be created"
      : "The abort hotkey event tap needs Accessibility permission for the desktop helper"
    return status
  }
  abortTap = tap
  let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  status["active"] = true
  return status
}

// MARK: - Main

func abortHotkeyArgument() -> String {
  let args = CommandLine.arguments
  for (index, arg) in args.enumerated() {
    if arg.hasPrefix("--abort-hotkey=") {
      return String(arg.dropFirst("--abort-hotkey=".count))
    }
    if arg == "--abort-hotkey", index + 1 < args.count {
      return args[index + 1]
    }
  }
  return defaultAbortHotkey
}

let requestQueue = DispatchQueue(label: "ai.tavi.desktop-helper.requests")
let hotkeyStatus = installAbortTap(combo: abortHotkeyArgument())
writeJsonLine([
  "type": "ready",
  "version": 2,
  "accessibility": AXIsProcessTrusted(),
  "abortHotkey": hotkeyStatus,
])

let reader = Thread {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
      continue
    }
    guard let req = try? JSONDecoder().decode(BridgeRequest.self, from: data) else {
      // Answer a request that cannot be decoded but still names its id, so the bridge does not wait on it.
      if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = object["id"] as? String {
        writeJsonLine(["id": id, "ok": false, "error": "Malformed request"])
      }
      continue
    }
    if req.method == "cancel" {
      raiseAbort()
      writeJsonLine(["id": req.id, "ok": true, "result": ["cancelled": true]])
      continue
    }
    let generation = abortGeneration.current
    requestQueue.async { runQueuedRequest(req, generation: generation) }
  }
  // stdin closed: the bridge is gone. Queued requests are dropped; only the one in flight finishes.
  stdinClosed.update { $0 = true }
  requestQueue.sync {}
  exit(0)
}
reader.start()
CFRunLoopRun()
