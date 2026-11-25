// electron-builder afterPack hook: stamps the app's own name, version and icon on the packaged exe.
//
// electron-builder normally does this itself, but that step is switched off in package.json
// (win.signAndEditExecutable: false) because its tooling needs symlink privileges an ordinary
// Windows account doesn't have. Without it the exe keeps Electron's identity, so shortcuts, Task
// Manager and Windows' "Installed apps" show "Electron" by "GitHub, Inc." with the atom icon.
const fs = require('fs')
const path = require('path')
const ResEdit = require('resedit')

exports.default = async function brandExe(context) {
  if (context.electronPlatformName !== 'win32') return
  const { appInfo } = context.packager
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`)

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath))
  const res = ResEdit.NtExecutableResource.from(exe)

  // The .ico electron-builder generated from build.win.icon (the same one the installer uses)
  const iconPath = await context.packager.getIconPath()
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath)).icons.map(icon => icon.data)
  for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons)
  }

  for (const info of ResEdit.Resource.VersionInfo.fromEntries(res.entries)) {
    for (const language of info.getAvailableLanguages()) {
      info.setStringValues(language, {
        ProductName: appInfo.productName,
        FileDescription: appInfo.productName, // the name Task Manager lists the process under
        CompanyName: appInfo.companyName || '',
        LegalCopyright: appInfo.copyright,
        InternalName: appInfo.productFilename,
        OriginalFilename: `${appInfo.productFilename}.exe`
      })
      info.setFileVersion(appInfo.version, language.lang)
      info.setProductVersion(appInfo.version, language.lang)
    }
    info.outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
}
