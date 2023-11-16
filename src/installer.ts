import { cp, mkdir, readdir, readFile, symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { env } from "node:process"

import * as cache from "@actions/cache"
import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import * as ini from "ini"

import { asError } from "./main"

interface Options {
  addToPath: boolean
  linkToSdk: boolean
  localCache: boolean
}

export async function getNdk(version: string, options: Options) {
  checkCompatibility()

  const cacheKey = getCacheKey(version)
  const cacheDir = path.join(os.homedir(), ".setup-ndk", version)

  let installPath: string
  installPath = tc.find("ndk", version)

  if (installPath) {
    core.info(`Found in tool cache @ ${installPath}`)
  } else if (options.localCache) {
    const restored = await cache.restoreCache([cacheDir], cacheKey)
    if (restored === cacheKey) {
      core.info(`Found in local cache @ ${cacheDir}`)
      installPath = cacheDir
    }
  }

  if (!installPath) {
    core.info(`Attempting to download ${version}...`)
    const downloadUrl = getDownloadUrl(version)
    const downloadPath = await tc.downloadTool(downloadUrl)

    core.info("Extracting...")
    const parentExtractPath = await tc.extractZip(downloadPath)
    const extractedFiles = await readdir(parentExtractPath)
    if (extractedFiles.length !== 1)
      throw new Error(
        `Invalid NDK archive contents (${extractedFiles.join(", ")})`,
      )
    const extractedPath = path.join(parentExtractPath, extractedFiles[0]!)

    core.info("Adding to the tool cache...")
    installPath = await tc.cacheDir(extractedPath, "ndk", version)

    if (options.localCache) {
      core.info("Adding to the local cache...")
      await mkdir(cacheDir, { recursive: true })
      await cp(installPath, cacheDir, { recursive: true })
      await cache.saveCache([cacheDir], cacheKey)
      installPath = cacheDir
    }

    core.info("Done")
  }

  if (options.addToPath) {
    core.addPath(installPath)
    core.info("Added to path")
  } else {
    core.info("Not added to path")
  }

  let fullVersion: string | undefined
  try {
    fullVersion = await getFullVersion(installPath)
  } catch (error) {
    core.warning(asError(error))
    core.warning("Failed to detect full version")
  }

  if (options.linkToSdk && fullVersion && "ANDROID_HOME" in env) {
    await linkToSdk(installPath, fullVersion, env.ANDROID_HOME!)
  }

  return { path: installPath, fullVersion }
}

async function linkToSdk(
  installPath: string,
  fullVersion: string,
  androidHome: string,
) {
  core.info("Linking to SDK...")

  const ndksPath = path.join(androidHome, "ndk")
  await mkdir(ndksPath, { recursive: true })

  const ndkPath = path.join(ndksPath, fullVersion)
  try {
    await symlink(installPath, ndkPath, "dir")
  } catch (error) {
    const exists =
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    if (!exists) throw error
  }
}

async function getFullVersion(installPath: string) {
  core.info("Detecting full version...")

  const propertiesPath = path.join(installPath, "source.properties")
  const propertiesContent = await readFile(propertiesPath, {
    encoding: "utf-8",
  })
  const properties = ini.parse(propertiesContent)

  if (
    "Pkg.Revision" in properties &&
    typeof properties["Pkg.Revision"] === "string"
  ) {
    const [fullVersion] = properties["Pkg.Revision"].split("-")
    return fullVersion!
  } else {
    throw new Error("source.properties file is missing Pkg.Revision")
  }
}

function checkCompatibility() {
  const platform = os.platform()
  const supportedPlatforms = ["linux", "win32", "darwin"]
  if (!supportedPlatforms.includes(platform)) {
    throw new Error(`Unsupported platform "${platform}"`)
  }
}

function getPlatormString() {
  const platform = os.platform()
  switch (platform) {
    case "linux":
      return "-linux"
    case "win32":
      return "-windows"
    case "darwin":
      return "-darwin"
    default:
      throw new Error()
  }
}

function getArchString(version: string) {
  const numStr = version.slice(1)
  const num = parseInt(numStr, 10)

  if (num >= 23) {
    return ""
  }

  const arch = os.arch()
  switch (arch) {
    case "x64":
      return "-x86_64"
    default:
      throw new Error()
  }
}

function getCacheKey(version: string) {
  const platform = getPlatormString()
  return `setup-ndk-${version}${platform}`
}

function getDownloadUrl(version: string) {
  const platform = getPlatormString()
  const arch = getArchString(version)
  return `https://dl.google.com/android/repository/android-ndk-${version}${platform}${arch}.zip`
}
