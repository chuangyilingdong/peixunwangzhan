"""Launch an installed browser without reading its existing user profile."""
import os
from pathlib import Path


class BrowserLaunchError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def browser_paths(executable):
    folder = 'Microsoft/Edge/Application' if executable == 'msedge.exe' else 'Google/Chrome/Application'
    for variable in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'):
        if os.environ.get(variable):
            path = Path(os.environ[variable]) / folder / executable
            if path.is_file():
                yield path
    if os.name != 'nt':
        return
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (0, winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' + '\\' + executable,
                                    0, winreg.KEY_READ | view) as key:
                    value = winreg.QueryValueEx(key, '')[0]
                path = Path(os.path.expandvars(value.strip().strip('"')))
                if path.is_file():
                    yield path
            except OSError:
                pass


async def launch_browser(chromium, *, headless):
    failed = False
    # Linux 服务器一般没有系统 Chrome/Edge：优先用 Playwright 自带的 Chromium
    # （deploy/production/setup-junshi-douyin-runtime.sh 会 `playwright install chromium`）。
    if os.name != 'nt':
        try:
            return await chromium.launch(headless=headless)
        except Exception:
            failed = True
    for channel, executable in (('msedge', 'msedge.exe'), ('chrome', 'chrome.exe')):
        options = [{'channel': channel}]
        options.extend({'executable_path': str(path)} for path in dict.fromkeys(browser_paths(executable)))
        for option in options:
            try:
                return await chromium.launch(**option, headless=headless)
            except Exception as exc:
                message = str(exc).lower()
                if not any(text in message for text in ('not found', "doesn't exist", 'does not exist')):
                    failed = True
    try:
        return await chromium.launch(headless=headless)
    except Exception:
        raise BrowserLaunchError('browser_launch_failed' if failed else 'browser_missing')


def browser_error_code(exc):
    if isinstance(exc, BrowserLaunchError):
        return exc.code
    if isinstance(exc, ModuleNotFoundError):
        return 'browser_component_missing'
    if 'net::ERR_' in str(exc):
        return 'network_failed'
    if type(exc).__name__ == 'TimeoutError':
        return 'page_load_timeout'
    return 'browser_read_failed'
