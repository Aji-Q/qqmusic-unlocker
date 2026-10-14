// QQ 音乐解锁器原生入口（Objective-C / AppKit）。
//
// 为什么需要它：shell 脚本收不到 Apple Event。一旦 Info.plist 声明了文档类型，
// `open -a App file.mgg` 就会把文件走 Apple Event 发过来，脚本收不到就被静默丢弃。
// 这个进程负责：启动本地服务、接住 open-documents 事件、把文件转发进队列、
// 在自带的 WKWebView 窗口里显示界面（不经过外部浏览器），关窗即退出并收掉服务。
//
// 拖拽：WKWebView 的 File 对象不带真实路径（和 Safari 一样），所以文件拖进窗口时
// 由原生层从剪贴板取路径直接送进队列，不交给页面里的 drop 处理。
//
// 编译：clang -fobjc-arc -O2 -o QQMusicUnlocker main.m -framework AppKit -framework Foundation -framework WebKit

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const kLogDir = @"Library/Logs/QQMusicUnlocker";

static NSString *HomeDir(void) { return NSHomeDirectory(); }
static NSString *LogFile(void) { return [HomeDir() stringByAppendingPathComponent:[kLogDir stringByAppendingPathComponent:@"launcher.log"]]; }
static NSString *AppCodeDir(void) { return [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"app"]; }
static NSString *ServicePath(void)
{
    NSString *binary = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"service/QQMusicService"];
    if ([[[NSBundle mainBundle] objectForInfoDictionaryKey:@"QQMusicStandalone"] boolValue] ||
        [[NSFileManager defaultManager] isExecutableFileAtPath:binary]) return binary.stringByResolvingSymlinksInPath;
    return [[AppCodeDir() stringByAppendingPathComponent:@"server.py"] stringByResolvingSymlinksInPath];
}
static NSString *AppVersion(void) { return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"dev"; }
static NSString *RuntimeFile(void)
{
    // Isolate copies and builds: a new bundle never attaches to an old UI service.
    NSString *identity = [NSString stringWithFormat:@"%@|%@|%@", ServicePath(), AppVersion(),
                           [[NSBundle mainBundle] objectForInfoDictionaryKey:@"QQMusicBuildID"] ?: @"dev"];
    NSData *data = [identity dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *key = [NSMutableString string];
    for (int i = 0; i < 12; i++) [key appendFormat:@"%02x", digest[i]];
    NSString *name = [NSString stringWithFormat:@"runtime-%@.json", key];
    return [HomeDir() stringByAppendingPathComponent:[kLogDir stringByAppendingPathComponent:name]];
}


static void AppendLog(NSString *message)
{
    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    fmt.dateFormat = @"yyyy-MM-dd HH:mm:ss";
    NSString *line = [NSString stringWithFormat:@"%@ %@\n", [fmt stringFromDate:[NSDate date]], message];
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm createDirectoryAtPath:[LogFile() stringByDeletingLastPathComponent]
  withIntermediateDirectories:YES attributes:nil error:NULL];
    if (![fm fileExistsAtPath:LogFile()]) {
        [line writeToFile:LogFile() atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        return;
    }
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:LogFile()];
    [fh seekToEndOfFile];
    [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
    [fh closeFile];
}

static void ShowAlert(NSString *title, NSString *text)
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = text;
    alert.alertStyle = NSAlertStyleWarning;
    [alert runModal];
}

/// 可用的 python3（能 import plistlib / sqlite3）
static NSString *FindPython(void)
{
    NSArray *candidates = @[@"/opt/homebrew/bin/python3", @"/usr/local/bin/python3", @"/usr/bin/python3"];
    for (NSString *path in candidates) {
        if (![[NSFileManager defaultManager] isExecutableFileAtPath:path]) continue;
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:path];
        task.arguments = @[@"-c", @"import plistlib, sqlite3"];
        task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
        task.standardError = [NSFileHandle fileHandleWithNullDevice];
        if (![task launchAndReturnError:NULL]) continue;
        [task waitUntilExit];
        if (task.terminationStatus == 0) return path;
    }
    return nil;
}

static BOOL ProcessAlive(NSInteger pid)
{
    return pid > 0 && kill((pid_t)pid, 0) == 0;
}

/// 读取并校验 runtime.json（服务进程必须还活着）
static NSDictionary *RuntimeInfo(void)
{
    NSData *data = [NSData dataWithContentsOfFile:RuntimeFile()];
    if (!data) return nil;
    NSDictionary *obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![obj isKindOfClass:[NSDictionary class]]) return nil;
    NSNumber *pid = obj[@"pid"];
    if (!pid || !ProcessAlive(pid.integerValue)) return nil;
    if (![obj[@"version"] isEqualToString:AppVersion()] ||
        ![obj[@"service_path"] isEqualToString:ServicePath()]) return nil;
    return obj;
}

static NSDictionary *LaunchEnvironment(void)
{
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSString *extra = @"/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    NSString *current = env[@"PATH"] ?: @"";
    env[@"PATH"] = [NSString stringWithFormat:@"%@:%@", extra, current];
    return env;
}

@class UnlockerDelegate;

/// 接管文件拖放：拖动过程交给页面（高亮投放区），松手时由原生层送路径
@interface DropWebView : WKWebView
@property (nonatomic, weak) UnlockerDelegate *owner;
@end

@interface UnlockerDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply>
@property (nonatomic, strong) NSTask *server;
@property (nonatomic, strong) NSMutableArray<NSString *> *pendingFiles;
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) DropWebView *webView;
@property (nonatomic, strong) NSTimer *watchdog;
@property (nonatomic, strong) NSOpenPanel *activePicker;
@property (nonatomic) BOOL pageReady;
- (BOOL)pushPaths:(NSArray<NSString *> *)paths;
@end

@implementation DropWebView

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender
{
    NSArray<NSURL *> *urls = [sender.draggingPasteboard readObjectsForClasses:@[[NSURL class]]
                                                                      options:@{NSPasteboardURLReadingFileURLsOnlyKey : @YES}];
    if (urls.count == 0) return [super performDragOperation:sender];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *u in urls) [paths addObject:u.path];
    AppendLog([NSString stringWithFormat:@"窗口拖入 %lu 项", (unsigned long)paths.count]);
    // Preserve directories and invalid items so the API can report every outcome.
    [self.owner pushPaths:paths];
    // lastVersion / poll 是 app.js 顶层声明，强制页面立即刷新队列
    [self evaluateJavaScript:@"document.getElementById('dropZone').classList.remove('hot');"
                              "if (typeof poll === 'function') { lastVersion = -1; poll(); }"
           completionHandler:nil];
    return YES;
}

@end

@implementation UnlockerDelegate

- (instancetype)init
{
    if ((self = [super init])) {
        _pendingFiles = [NSMutableArray array];
    }
    return self;
}

- (BOOL)startServer
{
    if (RuntimeInfo()) return YES;

    NSString *service = ServicePath();
    BOOL bundled = [service.lastPathComponent isEqualToString:@"QQMusicService"];
    NSString *executable = bundled ? service : FindPython();
    if (!executable || ![[NSFileManager defaultManager] isExecutableFileAtPath:executable]) {
        ShowAlert(@"应用不完整", @"请重新下载 macOS 应用并完整解压。源码开发版需要 Python 3 和 FFmpeg。");
        return NO;
    }

    NSString *logDir = [LogFile() stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:logDir
                             withIntermediateDirectories:YES attributes:nil error:NULL];
    if (![[NSFileManager defaultManager] fileExistsAtPath:LogFile()]) {
        [[NSData data] writeToFile:LogFile() atomically:YES];
    }

    NSString *token = [[NSUUID UUID].UUIDString stringByReplacingOccurrencesOfString:@"-" withString:@""].lowercaseString;

    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:executable];
    NSMutableArray *arguments = [NSMutableArray array];
    if (!bundled) [arguments addObject:service];
    [arguments addObjectsFromArray:@[@"--token", token, @"--runtime-file", RuntimeFile(), @"--no-browser"]];
    task.arguments = arguments;
    task.environment = LaunchEnvironment();
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:LogFile()];
    [fh seekToEndOfFile];
    task.standardOutput = fh;
    task.standardError = fh;
    if (![task launchAndReturnError:NULL]) {
        ShowAlert(@"启动失败", @"本地服务无法启动，详见 ~/Library/Logs/QQMusicUnlocker/launcher.log");
        return NO;
    }
    self.server = task;
    AppendLog([NSString stringWithFormat:@"新会话启动 pid=%d port=等待中", task.processIdentifier]);

    for (int i = 0; i < 80; i++) {
        if (RuntimeInfo()) return YES;
        if (!task.isRunning) break;
        [NSThread sleepForTimeInterval:0.25];
    }
    ShowAlert(@"启动失败", @"服务没有起来，详见 ~/Library/Logs/QQMusicUnlocker/launcher.log");
    return NO;
}

- (NSURL *)uiURL
{
    NSDictionary *info = RuntimeInfo();
    if (!info) return nil;
    NSNumber *port = info[@"port"];
    NSString *token = info[@"token"];
    return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@/?t=%@", port, token]];
}

- (void)openUI
{
    NSURL *url = [self uiURL];
    if (!url) return;
    if (!self.window) {
        NSRect frame = NSMakeRect(0, 0, 1080, 760);
        self.window = [[NSWindow alloc] initWithContentRect:frame
                                                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
        self.window.title = @"QQ音乐解锁器";
        self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
        self.window.backgroundColor = [NSColor colorWithCalibratedRed:245.0/255.0
                                                               green:242.0/255.0
                                                                blue:235.0/255.0 alpha:1.0];
        self.window.minSize = NSMakeSize(720, 520);
        self.window.delegate = self;
        self.window.releasedWhenClosed = NO;
        [self.window setFrameAutosaveName:@"MainWindow"];
        if (![self.window setFrameUsingName:@"MainWindow"]) [self.window center];

        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        [cfg.userContentController addScriptMessageHandlerWithReply:self
                                                       contentWorld:WKContentWorld.pageWorld name:@"picker"];
        self.webView = [[DropWebView alloc] initWithFrame:frame configuration:cfg];
        self.webView.owner = self;
        self.webView.UIDelegate = self;
        self.webView.navigationDelegate = self;
        self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.window.contentView = self.webView;
        [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
        AppendLog([NSString stringWithFormat:@"窗口加载 %@", url.host]);

        // 页面里点「退出服务」或服务崩溃：服务进程没了，窗口跟着退出
        self.watchdog = [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *t) {
            if (!RuntimeInfo()) {
                AppendLog(@"本地服务已不在，应用退出");
                [NSApp terminate:nil];
            }
        }];
    }
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

// The picker belongs to this window, so it cannot disappear behind an osascript process.
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler
{
    NSDictionary *runtime = RuntimeInfo();
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (!runtime || !message.frameInfo.mainFrame || message.webView != self.webView ||
        ![message.name isEqualToString:@"picker"] ||
        ![origin.protocol isEqualToString:@"http"] || ![origin.host isEqualToString:@"127.0.0.1"] ||
        origin.port != [runtime[@"port"] integerValue]) {
        replyHandler(nil, @"此页面无法使用文件选择器");
        return;
    }
    NSDictionary *body = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
    NSString *kind = [body[@"kind"] isKindOfClass:NSString.class] ? body[@"kind"] : nil;
    if (![@[@"files", @"folder", @"output"] containsObject:kind ?: @""]) {
        replyHandler(nil, @"未知的文件选择操作");
        return;
    }
    if (!self.window || self.activePicker || self.window.attachedSheet) {
        replyHandler(nil, @"请先关闭当前对话框，再选择文件");
        return;
    }
    BOOL files = [kind isEqualToString:@"files"];
    BOOL output = [kind isEqualToString:@"output"];
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = files ? @"添加文件" : (output ? @"选择输出文件夹" : @"添加文件夹");
    panel.prompt = @"选择";
    panel.canChooseFiles = files;
    panel.canChooseDirectories = !files;
    panel.allowsMultipleSelection = files;
    panel.canCreateDirectories = output;
    self.activePicker = panel;
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        self.activePicker = nil;
        if (files) {
            NSMutableArray<NSString *> *paths = [NSMutableArray array];
            if (result == NSModalResponseOK) {
                for (NSURL *url in panel.URLs) {
                    if (url.isFileURL && url.path) [paths addObject:url.path];
                }
            }
            replyHandler(@{@"paths": paths}, nil);
        } else {
            NSString *folder = result == NSModalResponseOK && panel.URL.isFileURL ? panel.URL.path : @"";
            replyHandler(@{@"folder": folder ?: @""}, nil);
        }
    }];
}

// ---- WKUIDelegate：页面里的 alert / confirm / prompt 默认在 WKWebView 中是静默的 ----

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = message;
    [alert addButtonWithTitle:@"好"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { completionHandler(); }];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = message;
    [alert addButtonWithTitle:@"确定"];
    [alert addButtonWithTitle:@"取消"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) {
        completionHandler(r == NSAlertFirstButtonReturn);
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
    defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame
    completionHandler:(void (^)(NSString *))completionHandler
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = prompt;
    [alert addButtonWithTitle:@"确定"];
    [alert addButtonWithTitle:@"取消"];
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 420, 120)];
    NSTextView *text = [[NSTextView alloc] initWithFrame:scroll.bounds];
    text.string = defaultText ?: @"";
    text.richText = NO;
    text.autoresizingMask = NSViewWidthSizable;
    scroll.documentView = text;
    scroll.hasVerticalScroller = YES;
    scroll.borderType = NSBezelBorder;
    alert.accessoryView = scroll;
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) {
        completionHandler(r == NSAlertFirstButtonReturn ? text.string : nil);
    }];
    [alert.window makeFirstResponder:text];
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation
{
    self.pageReady = NO;
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
    self.pageReady = YES;
    NSArray<NSString *> *paths = [self.pendingFiles copy];
    [self.pendingFiles removeAllObjects];
    if (paths.count) [self pushPaths:paths];
}

/// Use the page's import path so native drops also wait for pending settings saves.
- (BOOL)pushPaths:(NSArray<NSString *> *)paths
{
    if (paths.count == 0) return NO;
    if (!self.pageReady) {
        [self.pendingFiles addObjectsFromArray:paths];
        return YES;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:paths options:0 error:NULL];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:@"void window.addPaths(%@).catch(showError);", json];
    [self.webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        if (error) ShowAlert(@"无法添加文件", @"界面尚未就绪，请重新添加文件。");
    }];
    return YES;
}

- (void)quitServer
{
    NSDictionary *info = RuntimeInfo();
    if (!info) return;
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@/api/quit", info[@"port"]]];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = @"POST";
    req.timeoutInterval = 5;
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [req setValue:info[@"token"] forHTTPHeaderField:@"X-Token"];
    req.HTTPBody = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [[[NSURLSession sharedSession] dataTaskWithRequest:req
                                    completionHandler:^(NSData *d, NSURLResponse *r, NSError *e) {
        dispatch_semaphore_signal(sem);
    }] resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    // Files arriving before page load remain queued until didFinishNavigation.
    [self handleFiles:@[]];
}

- (void)handleFiles:(NSArray<NSString *> *)paths
{
    if (![self startServer]) {
        [NSApp terminate:nil];
        return;
    }
    if (paths.count) {
        AppendLog([NSString stringWithFormat:@"转发 %lu 项到队列", (unsigned long)paths.count]);
        [self pushPaths:paths];
    }
    [self openUI];
}

/// Finder 拖到图标 / open -a App file 都进这里
- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls
{
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *u in urls) {
        if (u.isFileURL) [paths addObject:u.path];
    }
    if (paths.count) [self handleFiles:paths];
}

- (BOOL)conversionRunning
{
    NSDictionary *info = RuntimeInfo();
    if (!info) return NO;
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@/api/state", info[@"port"]]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.timeoutInterval = 2;
    [request setValue:info[@"token"] forHTTPHeaderField:@"X-Token"];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL running = NO;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSDictionary *state = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        running = [state[@"running"] boolValue];
        dispatch_semaphore_signal(done);
    }] resume];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
    return running;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender
{
    if (![self conversionRunning]) return NSTerminateNow;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"正在转换";
    alert.informativeText = @"退出会中断当前转换。";
    [alert addButtonWithTitle:@"继续转换"];
    [alert addButtonWithTitle:@"退出"];
    return [alert runModal] == NSAlertSecondButtonReturn ? NSTerminateNow : NSTerminateCancel;
}

- (BOOL)windowShouldClose:(NSWindow *)sender
{
    [NSApp terminate:nil];
    return NO;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag
{
    if (!flag) [self openUI];
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification
{
    [self.activePicker cancel:nil];
    [self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"picker"
                                                                           contentWorld:WKContentWorld.pageWorld];
    AppendLog(@"应用退出，关闭本地服务");
    [self quitServer];
    if (self.server && self.server.isRunning) [self.server terminate];
}

@end

/// 没有主菜单时 WKWebView 里的 ⌘C / ⌘V / ⌘A 全部失效，⌘Q / ⌘W 也没有
static void InstallMenu(void)
{
    NSMenu *bar = [[NSMenu alloc] init];

    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"隐藏 QQ音乐解锁器" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"退出 QQ音乐解锁器" action:@selector(terminate:) keyEquivalent:@"q"];
    [[bar addItemWithTitle:@"" action:NULL keyEquivalent:@""] setSubmenu:appMenu];

    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"编辑"];
    [edit addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    [edit addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"Z"];
    [edit addItem:[NSMenuItem separatorItem]];
    [edit addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    [[bar addItemWithTitle:@"编辑" action:NULL keyEquivalent:@""] setSubmenu:edit];

    NSMenu *win = [[NSMenu alloc] initWithTitle:@"窗口"];
    [win addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [win addItemWithTitle:@"关闭" action:@selector(performClose:) keyEquivalent:@"w"];
    [win addItemWithTitle:@"重新载入" action:@selector(reload:) keyEquivalent:@"r"];
    [[bar addItemWithTitle:@"窗口" action:NULL keyEquivalent:@""] setSubmenu:win];

    NSApp.mainMenu = bar;
}

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        UnlockerDelegate *delegate = [[UnlockerDelegate alloc] init];
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        InstallMenu();
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
