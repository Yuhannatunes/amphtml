const argv = require('minimist')(process.argv.slice(2));
const debounce = require('../common/debounce');
const esbuild = require('esbuild');
/** @type {Object} */
const experimentDefines = require('../global-configs/experiments-const.json');
const fs = require('fs-extra');
const magicstring = require('magic-string');
const open = require('open');
const path = require('path');
const Remapping = require('@ampproject/remapping');
const terser = require('terser');
const wrappers = require('../compile/compile-wrappers');
const {
  VERSION: internalRuntimeVersion,
} = require('../compile/internal-version');
const {closureCompile} = require('../compile/compile');
const {cyan, green, red} = require('kleur/colors');
const {getAmpConfigForFile} = require('./prepend-global');
const {getEsbuildBabelPlugin} = require('../common/esbuild-babel');
const {getSourceRoot} = require('../compile/helpers');
const {isCiBuild} = require('../common/ci');
const {jsBundles} = require('../compile/bundles.config');
const {log, logLocalDev} = require('../common/logging');
const {thirdPartyFrames} = require('../test-configs/config');
const {watch} = require('chokidar');

/** @type {Remapping.default} */
const remapping = /** @type {*} */ (Remapping);

/** @type {magicstring.default} */
const MagicString = /** @type {*} */ (magicstring);

/**
 * Tasks that should print the `--nobuild` help text.
 * @private @const {!Set<string>}
 */
const NOBUILD_HELP_TASKS = new Set(['e2e', 'integration', 'visual-diff']);

/**
 * Used during minification to concatenate modules
 */
const MODULE_SEPARATOR = ';';

/**
 * Used during minification to concatenate extension bundles
 */
const EXTENSION_BUNDLE_MAP = {
  'amp-inputmask.js': ['third_party/inputmask/bundle.js'],
  'amp-date-picker.js': ['third_party/react-dates/bundle.js'],
  'amp-shadow-dom-polyfill.js': [
    'node_modules/@webcomponents/webcomponentsjs/bundles/webcomponents-sd.install.js',
  ],
};

/**
 * Used while building the 3p frame
 **/
const hostname3p = argv.hostname3p || '3p.ampproject.net';

/**
 * Used to debounce file edits during watch to prevent races.
 */
const watchDebounceDelay = 1000;

/**
 * Stores esbuild's watch mode rebuilders.
 * @private @const {!Map<string, {rebuild: function():!Promise<void>}>}
 */
const watchedTargets = new Map();

/**
 * @param {!Object} jsBundles
 * @param {string} name
 * @param {?Object} extraOptions
 * @return {!Promise}
 */
function doBuildJs(jsBundles, name, extraOptions) {
  const target = jsBundles[name];
  if (target) {
    return compileJs(
      target.srcDir,
      target.srcFilename,
      extraOptions.minify ? target.minifiedDestDir : target.destDir,
      {...target.options, ...extraOptions}
    );
  } else {
    return Promise.reject(
      [red('Error:'), 'Could not find', cyan(name)].join(' ')
    );
  }
}

/**
 * Generates frames.html
 *
 * @param {!Object} options
 * @return {Promise<void>}
 */
async function bootstrapThirdPartyFrames(options) {
  const startTime = Date.now();
  if (options.watch) {
    thirdPartyFrames.forEach((frameObject) => {
      const watchFunc = async () => {
        await thirdPartyBootstrap(frameObject.max, frameObject.min, options);
      };
      watch(frameObject.max).on(
        'change',
        debounce(watchFunc, watchDebounceDelay)
      );
    });
  }
  await Promise.all(
    thirdPartyFrames.map(async (frameObject) => {
      await thirdPartyBootstrap(frameObject.max, frameObject.min, options);
    })
  );
  endBuildStep(
    'Bootstrapped 3p frames into',
    `dist.3p/${options.minify ? internalRuntimeVersion : 'current'}/`,
    startTime
  );
}

/**
 * Compile and optionally minify the core runtime.
 *
 * @param {!Object} options
 * @return {Promise<void>}
 */
async function compileCoreRuntime(options) {
  await doBuildJs(jsBundles, 'amp.js', options);
}

/**
 * Compile and optionally minify the stylesheets and the scripts for the runtime
 * and drop them in the dist folder
 *
 * @param {!Object} options
 * @return {!Promise}
 */
async function compileAllJs(options) {
  const {minify} = options;
  if (minify) {
    log('Minifying multi-pass JS with', cyan('closure-compiler') + '...');
  } else {
    log('Compiling JS with', cyan('esbuild'), 'and', cyan('babel') + '...');
  }
  const startTime = Date.now();
  await Promise.all([
    minify ? Promise.resolve() : doBuildJs(jsBundles, 'polyfills.js', options),
    doBuildJs(jsBundles, 'bento.js', options),
    doBuildJs(jsBundles, 'alp.max.js', options),
    doBuildJs(jsBundles, 'integration.js', options),
    doBuildJs(jsBundles, 'ampcontext-lib.js', options),
    doBuildJs(jsBundles, 'iframe-transport-client-lib.js', options),
    doBuildJs(jsBundles, 'recaptcha.js', options),
    doBuildJs(jsBundles, 'amp-viewer-host.max.js', options),
    doBuildJs(jsBundles, 'video-iframe-integration.js', options),
    doBuildJs(jsBundles, 'amp-story-entry-point.js', options),
    doBuildJs(jsBundles, 'amp-story-player.js', options),
    doBuildJs(jsBundles, 'amp-inabox-host.js', options),
    doBuildJs(jsBundles, 'amp-shadow.js', options),
    doBuildJs(jsBundles, 'amp-inabox.js', options),
  ]);
  await compileCoreRuntime(options);
  endBuildStep(
    minify ? 'Minified' : 'Compiled',
    'all runtime JS files',
    startTime
  );
}

/**
 * Returns compiled file to prepend within wrapper and empty string if none.
 *
 * @param {string} srcFilename
 * @return {Promise<string>}
 */
async function getCompiledFile(srcFilename) {
  const bundleFiles = EXTENSION_BUNDLE_MAP[srcFilename];
  if (!bundleFiles) {
    return '';
  }
  const filesContents = await Promise.all(
    bundleFiles.map((file) => fs.readFile(file, 'utf8'))
  );
  return filesContents.join('\n');
}

/**
 * Allows pending inside the compile wrapper to the already minified JS file.
 * @param {string} srcFilename Name of the JS source file
 * @param {string} destFilePath File path to the minified JS file
 * @param {?Object} options
 */
function combineWithCompiledFile(srcFilename, destFilePath, options) {
  const bundleFiles = EXTENSION_BUNDLE_MAP[srcFilename];
  if (!bundleFiles) {
    return;
  }
  const bundle = new MagicString.Bundle({
    separator: '\n',
  });
  // We need to inject the code _inside_ the extension wrapper
  const destFileName = path.basename(destFilePath);
  /**
   * TODO (rileyajones) This should be import('magic-string').MagicStringOptions but
   * is invalid until https://github.com/Rich-Harris/magic-string/pull/183
   * is merged.
   * @type {Object}
   */
  const mapMagicStringOptions = {filename: destFileName};
  const contents = new MagicString(
    fs.readFileSync(destFilePath, 'utf8'),
    mapMagicStringOptions
  );
  const map = JSON.parse(fs.readFileSync(`${destFilePath}.map`, 'utf8'));
  const {sourceRoot} = map;
  map.sourceRoot = undefined;

  // The wrapper may have been minified further. Search backwards from the
  // expected <%=contents%> location to find the start of the `{` in the
  // wrapping function.
  const wrapperIndex = options.wrapper.indexOf('<%= contents %>');
  const index = contents.original.lastIndexOf('{', wrapperIndex) + 1;

  const wrapperOpen = contents.snip(0, index);
  const remainingContents = contents.snip(index, contents.length());

  bundle.addSource(wrapperOpen);
  for (const bundleFile of bundleFiles) {
    const contents = fs.readFileSync(bundleFile, 'utf8');
    /**
     * TODO (rileyajones) This should be import('magic-string').MagicStringOptions but
     * is invalid until https://github.com/Rich-Harris/magic-string/pull/183
     * is merged.
     * @type {Object}
     */
    const bundleMagicStringOptions = {filename: bundleFile};
    bundle.addSource(new MagicString(contents, bundleMagicStringOptions));
    bundle.append(MODULE_SEPARATOR);
  }
  bundle.addSource(remainingContents);

  const bundledMap = bundle.generateDecodedMap({
    file: destFileName,
    hires: true,
  });

  const remapped = remapping(
    bundledMap,
    (file) => {
      if (file === destFileName) {
        return map;
      }
      return null;
    },
    !argv.full_sourcemaps
  );
  remapped.sourceRoot = sourceRoot;

  fs.writeFileSync(destFilePath, bundle.toString(), 'utf8');
  fs.writeFileSync(`${destFilePath}.map`, remapped.toString(), 'utf8');
}

/**
 * @param {string} name
 * @return {string}
 */
function toEsmName(name) {
  return name.replace(/\.js$/, '.mjs');
}

/**
 * @param {string} name
 * @return {string}
 */
function maybeToEsmName(name) {
  // Npm esm names occur at an earlier stage.
  if (name.includes('.module')) {
    return name;
  }
  return argv.esm ? toEsmName(name) : name;
}

/**
 * @param {string} name
 * @return {string}
 */
function maybeToNpmEsmName(name) {
  return argv.esm ? name.replace(/\.js$/, '.module.js') : name;
}

/**
 * Minifies a given JavaScript file entry point.
 * @param {string} srcDir
 * @param {string} srcFilename
 * @param {string} destDir
 * @param {?Object} options
 * @return {!Promise}
 */
async function compileMinifiedJs(srcDir, srcFilename, destDir, options) {
  const timeInfo = {};
  const entryPoint = path.join(srcDir, srcFilename);
  const minifiedName = maybeToEsmName(options.minifiedName);

  options.errored = false;
  await closureCompile(entryPoint, destDir, minifiedName, options, timeInfo);
  // If an incremental watch build fails, simply return.
  if (options.watch && options.errored) {
    return;
  }

  const destPath = path.join(destDir, minifiedName);
  combineWithCompiledFile(srcFilename, destPath, options);
  if (options.aliasName) {
    fs.copySync(
      destPath,
      path.join(destDir, maybeToEsmName(options.aliasName))
    );
  }

  let name = minifiedName;
  if (options.aliasName) {
    name += ` → ${maybeToEsmName(options.aliasName)}`;
  }
  endBuildStep('Minified', name, timeInfo.startTime);
}

/**
 * Handles a bundling error
 * @param {Error} err
 * @param {boolean} continueOnError
 * @param {string} destFilename
 */
function handleBundleError(err, continueOnError, destFilename) {
  let message = err.toString();
  if (err.stack) {
    // Drop the node_modules call stack, which begins with '    at'.
    message = err.stack.replace(/    at[^]*/, '').trim();
  }
  log(red('ERROR:'), message, '\n');
  const reasonMessage = `Could not compile ${cyan(destFilename)}`;
  if (continueOnError) {
    log(red('ERROR:'), reasonMessage);
  } else {
    throw new Error(reasonMessage);
  }
}

/**
 * Performs the final steps after a JS file is bundled and optionally minified
 * with esbuild and babel.
 * @param {string} destDir
 * @param {string} destFilename
 * @param {?Object} options
 * @param {number} startTime
 * @return {Promise<void>}
 */
async function finishBundle(destDir, destFilename, options, startTime) {
  const logPrefix = options.minify ? 'Minified' : 'Compiled';
  let {aliasName} = options;
  if (aliasName) {
    if (!options.minify) {
      aliasName = aliasName.replace(/\.js$/, '.max.js');
    }
    aliasName = maybeToEsmName(aliasName);
    fs.copySync(
      path.join(destDir, destFilename),
      path.join(destDir, aliasName)
    );
    endBuildStep(logPrefix, `${destFilename} → ${aliasName}`, startTime);
  } else {
    const loggingName =
      options.npm && !destFilename.startsWith('amp-')
        ? `${options.name} → ${destFilename}`
        : destFilename;
    endBuildStep(logPrefix, loggingName, startTime);
  }
}

/**
 * Transforms a given JavaScript file entry point with esbuild and babel, and
 * watches it for changes (if required).
 *
 * @param {string} srcDir
 * @param {string} srcFilename
 * @param {string} destDir
 * @param {?Object} options
 * @return {!Promise}
 */
async function esbuildCompile(srcDir, srcFilename, destDir, options) {
  const startTime = Date.now();
  const entryPoint = path.join(srcDir, srcFilename);
  const filename = options.minify
    ? options.minifiedName
    : options.toName ?? srcFilename;
  const destFilename = maybeToEsmName(filename);
  const destFile = path.join(destDir, destFilename);

  if (watchedTargets.has(entryPoint)) {
    return watchedTargets.get(entryPoint).rebuild();
  }

  /**
   * Splits up the wrapper to compute the banner and footer
   * @return {Object}
   */
  function splitWrapper() {
    const wrapper = options.wrapper ?? wrappers.none;
    const sentinel = '<%= contents %>';
    const start = wrapper.indexOf(sentinel);
    return {
      banner: {js: wrapper.slice(0, start)},
      footer: {js: wrapper.slice(start + sentinel.length)},
    };
  }
  const {banner, footer} = splitWrapper();
  const config = await getAmpConfigForFile(destFilename, options);
  const compiledFile = await getCompiledFile(srcFilename);
  banner.js = config + banner.js + compiledFile;

  const babelPlugin = getEsbuildBabelPlugin(
    options.minify ? 'minified' : 'unminified',
    /* enableCache */ true
  );
  const plugins = [babelPlugin];

  if (options.remapDependencies) {
    plugins.unshift(remapDependenciesPlugin());
  }

  let result = null;

  /**
   * @param {number} startTime
   * @return {Promise<void>}
   */
  async function build(startTime) {
    if (!result) {
      result = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        sourcemap: true,
        outfile: destFile,
        define: experimentDefines,
        plugins,
        format: options.outputFormat,
        banner,
        footer,
        // For es5 builds, ensure esbuild-injected code is transpiled.
        target: argv.esm ? 'es6' : 'es5',
        incremental: !!options.watch,
        logLevel: 'silent',
        external: options.externalDependencies,
        write: false,
      });
    } else {
      result = await result.rebuild();
    }
    let code = result.outputFiles.find(({path}) => !path.endsWith('.map')).text;
    let map = result.outputFiles.find(({path}) => path.endsWith('.map')).text;

    if (options.minify) {
      ({code, map} = await minify(code, map));
      map = await massageSourcemaps(map, options);
    }

    await Promise.all([
      fs.outputFile(destFile, code),
      fs.outputFile(`${destFile}.map`, map),
    ]);

    await finishBundle(destDir, destFilename, options, startTime);
  }

  /**
   * Generates a plugin to remap the dependencies of a JS bundle.
   * @return {Object}
   */
  function remapDependenciesPlugin() {
    const remapDependencies = {__proto__: null, ...options.remapDependencies};
    const external = options.externalDependencies;
    return {
      name: 'remap-dependencies',
      setup(build) {
        build.onResolve({filter: /.*/}, (args) => {
          const dep = args.path;
          const remap = remapDependencies[dep];
          if (remap) {
            const isExternal = external.includes(remap);
            return {
              path: isExternal ? remap : require.resolve(remap),
              external: isExternal,
            };
          }
        });
      },
    };
  }

  await build(startTime).catch((err) =>
    handleBundleError(err, !!options.watch, destFilename)
  );

  if (options.watch) {
    watchedTargets.set(entryPoint, {
      rebuild: async () => {
        const startTime = Date.now();
        const buildPromise = build(startTime).catch((err) =>
          handleBundleError(err, !!options.watch, destFilename)
        );
        if (options.onWatchBuild) {
          options.onWatchBuild(buildPromise);
        }
        await buildPromise;
      },
    });
  }
}

/**
 * Name cache to help terser perform cross-binary property mangling.
 */
const nameCache = {};

/**
 * Minify the code with Terser. Only used by the ESBuild.
 *
 * @param {string} code
 * @param {string} map
 * @return {!Promise<{code: string, map: *, error?: Error}>}
 */
async function minify(code, map) {
  const terserOptions = {
    mangle: {
      properties: {
        regex: '_AMP_PRIVATE_$',
        // eslint-disable-next-line google-camelcase/google-camelcase
        keep_quoted: /** @type {'strict'} */ ('strict'),
      },
    },
    compress: {
      // Settled on this count by incrementing number until there was no more
      // effect on minification quality.
      passes: 3,
    },
    output: {
      beautify: !!argv.pretty_print,
      // eslint-disable-next-line google-camelcase/google-camelcase
      keep_quoted_props: true,
    },
    sourceMap: {content: map},
    module: !!argv.esm,
    nameCache,
  };
  // Remove the local variable name cache which should not be reused between binaries.
  // See https://github.com/ampproject/amphtml/issues/36476
  /** @type {any}*/ (nameCache).vars = {};

  const minified = await terser.minify(code, terserOptions);
  return {code: minified.code ?? '', map: minified.map};
}

/**
 * The set of entrypoints currently watched by compileJs.
 * @type {Set<string>}
 */
const watchedEntryPoints = new Set();

/**
 * Bundles (max) or compiles (min) a given JavaScript file entry point.
 *
 * @param {string} srcDir Path to the src directory
 * @param {string} srcFilename Name of the JS source file
 * @param {string} destDir Destination folder for output script
 * @param {?Object} options
 * @return {!Promise}
 */
async function compileJs(srcDir, srcFilename, destDir, options) {
  options = options || {};
  const entryPoint = path.join(srcDir, srcFilename);
  if (watchedEntryPoints.has(entryPoint)) {
    return;
  }

  if (options.watch) {
    watchedEntryPoints.add(entryPoint);
    const deps = await getDependencies(entryPoint, options);
    const watchFunc = async () => {
      await doCompileJs({...options, continueOnError: true});
    };
    watch(deps).on('change', debounce(watchFunc, watchDebounceDelay));
  }

  /**
   * Actually performs the steps to compile the entry point.
   * @param {Object} options
   * @return {Promise<void>}
   */
  async function doCompileJs(options) {
    const buildResult =
      options.minify && shouldUseClosure()
        ? compileMinifiedJs(srcDir, srcFilename, destDir, options)
        : esbuildCompile(srcDir, srcFilename, destDir, options);
    if (options.onWatchBuild) {
      options.onWatchBuild(buildResult);
    }
    await buildResult;
  }

  await doCompileJs(options);
}

/**
 * Stops the timer for the given build step and prints the execution time.
 * @param {string} stepName Name of the action, like 'Compiled' or 'Minified'
 * @param {string} targetName Name of the target, like a filename or path
 * @param {DOMHighResTimeStamp} startTime Start time of build step
 */
function endBuildStep(stepName, targetName, startTime) {
  const endTime = Date.now();
  const executionTime = new Date(endTime - startTime);
  const mins = executionTime.getMinutes();
  const secs = executionTime.getSeconds();
  const ms = ('000' + executionTime.getMilliseconds().toString()).slice(-3);
  let timeString = '(';
  if (mins > 0) {
    timeString += mins + ' m ' + secs + '.' + ms + ' s)';
  } else if (secs === 0) {
    timeString += ms + ' ms)';
  } else {
    timeString += secs + '.' + ms + ' s)';
  }
  log(stepName, cyan(targetName), green(timeString));
}

/**
 * Prints a helpful message that lets the developer know how to switch configs.
 * @param {string} command Command being run.
 */
function printConfigHelp(command) {
  log(
    green('Building version'),
    cyan(internalRuntimeVersion),
    green('of the runtime with the'),
    cyan(argv.config === 'canary' ? 'canary' : 'prod'),
    green('AMP config.')
  );
  logLocalDev(
    green('⤷ Use'),
    cyan('--config={canary|prod}'),
    green('with your'),
    cyan(command),
    green('command to specify which config to apply.')
  );
}

/**
 * Prints a message that could help speed up local development.
 */
function printNobuildHelp() {
  for (const task of NOBUILD_HELP_TASKS) {
    if (argv._.includes(task)) {
      log(
        green('To skip building during future'),
        cyan(task),
        green('runs, use'),
        cyan('--nobuild'),
        green('with your'),
        cyan(`amp ${task}`),
        green('command.')
      );
      return;
    }
  }
}

/**
 * @param {string=} covPath
 * @return {!Promise}
 */
async function maybePrintCoverageMessage(covPath = '') {
  if (!argv.coverage || isCiBuild()) {
    return;
  }

  const url = 'file://' + path.resolve(covPath);
  log(green('INFO:'), 'Generated code coverage report at', cyan(url));
  await open(url, {wait: false});
}

/**
 * Copies frame.html to output folder, replaces js references to minified
 * copies, and generates symlink to it.
 *
 * @param {string} input
 * @param {string} outputName
 * @param {!Object} options
 * @return {!Promise}
 */
async function thirdPartyBootstrap(input, outputName, options) {
  const {fortesting, minify} = options;
  const destDir = `dist.3p/${minify ? internalRuntimeVersion : 'current'}`;
  await fs.ensureDir(destDir);

  if (!minify) {
    await fs.copy(input, `${destDir}/${path.basename(input)}`);
    return;
  }

  // By default we use an absolute URL, that is independent of the
  // actual frame host for the JS inside the frame.
  // But during testing we need a relative reference because the
  // version is not available on the absolute path.
  const integrationJs = fortesting
    ? './f.js'
    : `https://${hostname3p}/${internalRuntimeVersion}/f.js`;
  // Convert default relative URL to absolute min URL.
  const html = fs
    .readFileSync(input, 'utf8')
    .replace(/\.\/integration\.js/g, integrationJs);
  await fs.writeFile(`${destDir}/${outputName}`, html);
  const aliasToLatestBuild = 'dist.3p/current-min';
  if (fs.existsSync(aliasToLatestBuild)) {
    fs.unlinkSync(aliasToLatestBuild);
  }
  fs.symlinkSync('./' + internalRuntimeVersion, aliasToLatestBuild, 'dir');
}

/**
 *Creates directory in sync manner
 *
 * @param {string} path
 */
function mkdirSync(path) {
  try {
    fs.mkdirSync(path);
  } catch (e) {
    if (e.code != 'EEXIST') {
      throw e;
    }
  }
}

/**
 * Returns the list of dependencies for a given JS entrypoint by having esbuild
 * generate a metafile for it. Uses the set of babel plugins that would've been
 * used to compile the entrypoint.
 *
 * @param {string} entryPoint
 * @param {!Object} options
 * @return {Promise<Array<string>>}
 */
async function getDependencies(entryPoint, options) {
  const caller = options.minify ? 'minified' : 'unminified';
  const babelPlugin = getEsbuildBabelPlugin(caller, /* enableCache */ true);
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    metafile: true,
    plugins: [babelPlugin],
  });
  return Object.keys(result.metafile?.inputs ?? {});
}

/**
 * @param {*} sourcemapsFile
 * @param {*} options
 * @return {*}
 */
function massageSourcemaps(sourcemapsFile, options) {
  const sourcemaps = JSON.parse(sourcemapsFile);
  sourcemaps.sources = sourcemaps.sources.map((source) => {
    if (source.startsWith('../')) {
      return source.slice('../'.length);
    }
    return source;
  });
  sourcemaps.sourceRoot = getSourceRoot(options);
  if (sourcemaps.file) {
    sourcemaps.file = path.basename(sourcemaps.file);
  }
  if (!argv.full_sourcemaps) {
    delete sourcemaps.sourcesContent;
  }

  return JSON.stringify(sourcemaps);
}

/**
 * Returns whether or not we should compile with Closure Compiler.
 * @return {boolean}
 */
function shouldUseClosure() {
  // Normally setting this server-side experiment flag would be handled by
  // the release process automatically. Since this experiment is actually on the build system
  // itself instead of runtime, it is never run through babel (where the replacements usually happen).
  // Therefore we must compute this one by hand.
  return argv.define_experiment_constant !== 'ESBUILD_COMPILATION';
}

module.exports = {
  bootstrapThirdPartyFrames,
  compileAllJs,
  compileCoreRuntime,
  compileJs,
  esbuildCompile,
  doBuildJs,
  endBuildStep,
  maybePrintCoverageMessage,
  maybeToEsmName,
  maybeToNpmEsmName,
  mkdirSync,
  printConfigHelp,
  printNobuildHelp,
  watchDebounceDelay,
  shouldUseClosure,
};
