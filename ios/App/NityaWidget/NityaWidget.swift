//
//  NityaWidget.swift
//  mySanskar — home-screen widget for the "Nitya" daily-plays list.
//
//  Renders the list the web app writes into the shared App Group. Each row is a
//  Link to  mysanskar://nitya/play?id=<trackId>  which opens the app and plays.
//  (Deliberately NOT using AppIntents so it works on iOS 15+, per product decision.)
//
//  Xcode setup (see NITYA_WIDGET_SETUP.md):
//   • Add this file to a new "Widget Extension" target named NityaWidget.
//   • Add the App Group  group.com.ankitpatel5.mysanskar  to BOTH targets.
//

import WidgetKit
import SwiftUI

// MARK: - Shared model

let kAppGroup = "group.com.ankitpatel5.mysanskar"
let kNityaKey = "nitya.items"

struct NityaItem: Identifiable, Codable {
    let id: String      // Drive file / track id — used in the deep link
    let name: String
    let album: String
}

// Reads the JSON list the web app syncs via the NityaWidget Capacitor plugin.
func loadNityaItems() -> [NityaItem] {
    guard let defaults = UserDefaults(suiteName: kAppGroup),
          let raw = defaults.string(forKey: kNityaKey),
          let data = raw.data(using: .utf8),
          let items = try? JSONDecoder().decode([NityaItem].self, from: data)
    else { return [] }
    return items
}

// MARK: - Timeline

struct NityaEntry: TimelineEntry {
    let date: Date
    let items: [NityaItem]
}

struct NityaProvider: TimelineProvider {
    func placeholder(in context: Context) -> NityaEntry {
        NityaEntry(date: Date(), items: [
            NityaItem(id: "0", name: "Arti", album: "Arti"),
            NityaItem(id: "1", name: "Chesta", album: "Chesta"),
            NityaItem(id: "2", name: "Namavali", album: "Namavali")
        ])
    }
    func getSnapshot(in context: Context, completion: @escaping (NityaEntry) -> Void) {
        completion(NityaEntry(date: Date(), items: loadNityaItems()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<NityaEntry>) -> Void) {
        // Static until the app pushes a reload via WidgetCenter; refresh hourly as a safety net.
        let entry = NityaEntry(date: Date(), items: loadNityaItems())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(3600))))
    }
}

// MARK: - Views

private let saffron = Color(red: 0xE8/255, green: 0xA3/255, blue: 0x3D/255)
private let bg0     = Color(red: 0x0D/255, green: 0x0B/255, blue: 0x07/255)

struct NityaRow: View {
    let item: NityaItem
    var body: some View {
        // Tapping the row opens the app at the play deep link.
        Link(destination: URL(string: "mysanskar://nitya/play?id=\(item.id)")!) {
            HStack(spacing: 10) {
                Text(String(item.name.first.map(String.init) ?? "♪"))
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .foregroundColor(saffron)
                    .frame(width: 34, height: 34)
                    .background(saffron.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name).font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white).lineLimit(1)
                    if !item.album.isEmpty {
                        Text(item.album).font(.system(size: 11))
                            .foregroundColor(.white.opacity(0.5)).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 22)).foregroundColor(saffron)
            }
        }
    }
}

struct NityaWidgetView: View {
    let entry: NityaEntry
    @Environment(\.widgetFamily) var family

    var maxRows: Int { family == .systemLarge ? 6 : 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Nitya").font(.system(size: 15, weight: .bold, design: .serif))
                    .foregroundColor(.white)
                Spacer()
                Text("Daily plays").font(.system(size: 11)).foregroundColor(saffron)
            }
            if entry.items.isEmpty {
                Spacer()
                Text("Add songs to Nitya in mySanskar")
                    .font(.system(size: 12)).foregroundColor(.white.opacity(0.5))
                Spacer()
            } else {
                ForEach(entry.items.prefix(maxRows)) { NityaRow(item: $0) }
                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .widgetBackground(bg0)
    }
}

// iOS 17 requires containerBackground; keep a fallback for iOS 15/16.
extension View {
    @ViewBuilder func widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(color, for: .widget)
        } else {
            self.background(color)
        }
    }
}

// MARK: - Widget

struct NityaWidget: Widget {
    let kind = "NityaWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NityaProvider()) { entry in
            NityaWidgetView(entry: entry)
        }
        .configurationDisplayName("Nitya")
        .description("Your daily plays — tap to play in mySanskar.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

@main
struct NityaWidgetBundle: WidgetBundle {
    var body: some Widget { NityaWidget() }
}
