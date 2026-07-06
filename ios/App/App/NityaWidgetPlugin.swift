//
//  NityaWidgetPlugin.swift
//  mySanskar — Capacitor bridge that mirrors the web app's Nitya list into the
//  shared App Group so the home-screen widget can render it.
//
//  JS usage (already wired in app.js):
//     window.Capacitor.Plugins.NityaWidget.sync({ items: [{id,name,album}, ...] })
//
//  Xcode setup (see NITYA_WIDGET_SETUP.md):
//   • Add this file to the App target.
//   • Add App Group  group.com.ankitpatel5.mysanskar  to the App target.
//

import Foundation
import Capacitor
import WidgetKit

@objc(NityaWidgetPlugin)
public class NityaWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NityaWidgetPlugin"
    public let jsName = "NityaWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise)
    ]

    static let appGroup = "group.com.ankitpatel5.mysanskar"
    static let itemsKey = "nitya.items"
    static let widgetKind = "NityaWidget"

    @objc func sync(_ call: CAPPluginCall) {
        let items = call.getArray("items") ?? []
        let mapped: [[String: String]] = items.compactMap { value in
            // Bridged JS objects arrive as NSDictionary — cast loosely, not to JSObject.
            guard let obj = value as? [String: Any] else { return nil }
            return [
                "id":    (obj["id"]    as? String) ?? "",
                "name":  (obj["name"]  as? String) ?? "",
                "album": (obj["album"] as? String) ?? ""
            ]
        }.filter { !($0["id"]?.isEmpty ?? true) }

        if let data = try? JSONSerialization.data(withJSONObject: mapped),
           let json = String(data: data, encoding: .utf8),
           let defaults = UserDefaults(suiteName: Self.appGroup) {
            defaults.set(json, forKey: Self.itemsKey)
        }

        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        }
        call.resolve()
    }
}
