import memoize from 'memoizerific';
import type {
  IndexEntry,
  Renderer,
  ComponentTitle,
  Parameters,
  Path,
  ProjectAnnotations,
  BoundStory,
  CSFFile,
  ModuleExports,
  ModuleImportFn,
  NormalizedProjectAnnotations,
  PreparedStory,
  StoryIndex,
  StoryIndexV3,
  V3CompatIndexEntry,
  StoryContext,
  StoryContextForEnhancers,
  StoryContextForLoaders,
  StoryId,
  PreparedMeta,
} from '@storybook/types';
import mapValues from 'lodash/mapValues.js';
import pick from 'lodash/pick.js';

import {
  CalledExtractOnStoreError,
  MissingStoryFromCsfFileError,
} from '@storybook/core-events/preview-errors';
import { deprecate } from '@storybook/client-logger';
import { HooksContext } from '../addons';
import { StoryIndexStore } from './StoryIndexStore';
import { ArgsStore } from './ArgsStore';
import { GlobalsStore } from './GlobalsStore';
import {
  processCSFFile,
  prepareStory,
  prepareMeta,
  normalizeProjectAnnotations,
  prepareContext,
} from './csf';

// TODO -- what are reasonable values for these?
const CSF_CACHE_SIZE = 1000;
const STORY_CACHE_SIZE = 10000;

export class StoryStore<TRenderer extends Renderer> {
  public storyIndex: StoryIndexStore;

  projectAnnotations: NormalizedProjectAnnotations<TRenderer>;

  globals: GlobalsStore;

  args: ArgsStore;

  hooks: Record<StoryId, HooksContext<TRenderer>>;

  cachedCSFFiles?: Record<Path, CSFFile<TRenderer>>;

  processCSFFileWithCache: typeof processCSFFile;

  prepareMetaWithCache: typeof prepareMeta;

  prepareStoryWithCache: typeof prepareStory;

  constructor(
    storyIndex: StoryIndex,

    public importFn: ModuleImportFn,

    projectAnnotations: ProjectAnnotations<TRenderer>
  ) {
    this.storyIndex = new StoryIndexStore(storyIndex);

    this.projectAnnotations = normalizeProjectAnnotations(projectAnnotations);
    const { globals, globalTypes } = projectAnnotations;

    this.args = new ArgsStore();
    this.globals = new GlobalsStore({ globals, globalTypes });
    this.hooks = {};

    // We use a cache for these two functions for two reasons:
    //  1. For performance
    //  2. To ensure that when the same story is prepared with the same inputs you get the same output
    this.processCSFFileWithCache = memoize(CSF_CACHE_SIZE)(processCSFFile) as typeof processCSFFile;
    this.prepareMetaWithCache = memoize(CSF_CACHE_SIZE)(prepareMeta) as typeof prepareMeta;
    this.prepareStoryWithCache = memoize(STORY_CACHE_SIZE)(prepareStory) as typeof prepareStory;
  }

  setProjectAnnotations(projectAnnotations: ProjectAnnotations<TRenderer>) {
    // By changing `this.projectAnnotations, we implicitly invalidate the `prepareStoryWithCache`
    this.projectAnnotations = normalizeProjectAnnotations(projectAnnotations);
    const { globals, globalTypes } = projectAnnotations;
    this.globals.set({ globals, globalTypes });
  }

  // This means that one of the CSF files has changed.
  // If the `importFn` has changed, we will invalidate both caches.
  // If the `storyIndex` data has changed, we may or may not invalidate the caches, depending
  // on whether we've loaded the relevant files yet.
  async onStoriesChanged({
    importFn,
    storyIndex,
  }: {
    importFn?: ModuleImportFn;
    storyIndex?: StoryIndex;
  }) {
    if (importFn) this.importFn = importFn;
    // The index will always be set before the initialization promise returns
    if (storyIndex) this.storyIndex.entries = storyIndex.entries;
    if (this.cachedCSFFiles) await this.cacheAllCSFFiles();
  }

  // Get an entry from the index, waiting on initialization if necessary
  async storyIdToEntry(storyId: StoryId): Promise<IndexEntry> {
    // The index will always be set before the initialization promise returns
    return this.storyIndex.storyIdToEntry(storyId);
  }

  // To load a single CSF file to service a story we need to look up the importPath in the index
  async loadCSFFileByStoryId(storyId: StoryId): Promise<CSFFile<TRenderer>> {
    const { importPath, title } = this.storyIndex.storyIdToEntry(storyId);
    const moduleExports = await this.importFn(importPath);

    // We pass the title in here as it may have been generated by autoTitle on the server.
    return this.processCSFFileWithCache(moduleExports, importPath, title);
  }

  async loadAllCSFFiles(): Promise<StoryStore<TRenderer>['cachedCSFFiles']> {
    const importPaths: Record<Path, StoryId> = {};
    Object.entries(this.storyIndex.entries).forEach(([storyId, { importPath }]) => {
      importPaths[importPath] = storyId;
    });

    const csfFilePromiseList = Object.entries(importPaths).map(([importPath, storyId]) =>
      this.loadCSFFileByStoryId(storyId).then((csfFile) => ({
        importPath,
        csfFile,
      }))
    );

    return Promise.all(csfFilePromiseList).then((list) =>
      list.reduce(
        (acc, { importPath, csfFile }) => {
          acc[importPath] = csfFile;
          return acc;
        },
        {} as Record<Path, CSFFile<TRenderer>>
      )
    );
  }

  async cacheAllCSFFiles(): Promise<void> {
    this.cachedCSFFiles = await this.loadAllCSFFiles();
  }

  preparedMetaFromCSFFile({ csfFile }: { csfFile: CSFFile<TRenderer> }): PreparedMeta<TRenderer> {
    const componentAnnotations = csfFile.meta;

    return this.prepareMetaWithCache(
      componentAnnotations,
      this.projectAnnotations,
      csfFile.moduleExports.default
    );
  }

  // Load the CSF file for a story and prepare the story from it and the project annotations.
  async loadStory({ storyId }: { storyId: StoryId }): Promise<PreparedStory<TRenderer>> {
    const csfFile = await this.loadCSFFileByStoryId(storyId);
    return this.storyFromCSFFile({ storyId, csfFile });
  }

  // This function is synchronous for convenience -- often times if you have a CSF file already
  // it is easier not to have to await `loadStory`.
  storyFromCSFFile({
    storyId,
    csfFile,
  }: {
    storyId: StoryId;
    csfFile: CSFFile<TRenderer>;
  }): PreparedStory<TRenderer> {
    const storyAnnotations = csfFile.stories[storyId];
    if (!storyAnnotations) throw new MissingStoryFromCsfFileError({ storyId });

    const componentAnnotations = csfFile.meta;

    const story = this.prepareStoryWithCache(
      storyAnnotations,
      componentAnnotations,
      this.projectAnnotations
    );
    this.args.setInitial(story);
    this.hooks[story.id] = this.hooks[story.id] || new HooksContext();
    return story;
  }

  // If we have a CSF file we can get all the stories from it synchronously
  componentStoriesFromCSFFile({
    csfFile,
  }: {
    csfFile: CSFFile<TRenderer>;
  }): PreparedStory<TRenderer>[] {
    return Object.keys(this.storyIndex.entries)
      .filter((storyId: StoryId) => !!csfFile.stories[storyId])
      .map((storyId: StoryId) => this.storyFromCSFFile({ storyId, csfFile }));
  }

  async loadEntry(id: StoryId) {
    const entry = await this.storyIdToEntry(id);

    const storyImports = entry.type === 'docs' ? entry.storiesImports : [];

    const [entryExports, ...csfFiles] = (await Promise.all([
      this.importFn(entry.importPath),
      ...storyImports.map((storyImportPath) => {
        const firstStoryEntry = this.storyIndex.importPathToEntry(storyImportPath);
        return this.loadCSFFileByStoryId(firstStoryEntry.id);
      }),
    ])) as [ModuleExports, ...CSFFile<TRenderer>[]];

    return { entryExports, csfFiles };
  }

  // A prepared story does not include args, globals or hooks. These are stored in the story store
  // and updated separtely to the (immutable) story.
  getStoryContext(
    story: PreparedStory<TRenderer>,
    { forceInitialArgs = false } = {}
  ): Omit<StoryContextForLoaders, 'viewMode'> {
    return prepareContext({
      ...story,
      args: forceInitialArgs ? story.initialArgs : this.args.get(story.id),
      globals: this.globals.get(),
      hooks: this.hooks[story.id] as unknown,
    });
  }

  cleanupStory(story: PreparedStory<TRenderer>): void {
    this.hooks[story.id].clean();
  }

  extract(
    options: { includeDocsOnly?: boolean } = { includeDocsOnly: false }
  ): Record<StoryId, StoryContextForEnhancers<TRenderer>> {
    const { cachedCSFFiles } = this;
    if (!cachedCSFFiles) throw new CalledExtractOnStoreError();

    return Object.entries(this.storyIndex.entries).reduce(
      (acc, [storyId, { type, importPath }]) => {
        if (type === 'docs') return acc;

        const csfFile = cachedCSFFiles[importPath];
        const story = this.storyFromCSFFile({ storyId, csfFile });

        if (!options.includeDocsOnly && story.parameters.docsOnly) {
          return acc;
        }

        acc[storyId] = Object.entries(story).reduce(
          (storyAcc, [key, value]) => {
            if (key === 'moduleExport') return storyAcc;
            if (typeof value === 'function') {
              return storyAcc;
            }
            if (Array.isArray(value)) {
              return Object.assign(storyAcc, { [key]: value.slice().sort() });
            }
            return Object.assign(storyAcc, { [key]: value });
          },
          { args: story.initialArgs }
        );
        return acc;
      },
      {} as Record<string, any>
    );
  }

  getSetStoriesPayload() {
    const stories = this.extract({ includeDocsOnly: true });

    const kindParameters: Parameters = Object.values(stories).reduce(
      (acc: Parameters, { title }: { title: ComponentTitle }) => {
        acc[title] = {};
        return acc;
      },
      {} as Parameters
    );

    return {
      v: 2,
      globals: this.globals.get(),
      globalParameters: {},
      kindParameters,
      stories,
    };
  }

  // NOTE: this is legacy `stories.json` data for the `extract` script.
  // It is used to allow v7 Storybooks to be composed in v6 Storybooks, which expect a
  // `stories.json` file with legacy fields (`kind` etc).
  getStoriesJsonData = (): StoryIndexV3 => {
    const value = this.getSetStoriesPayload();
    const allowedParameters = ['fileName', 'docsOnly', 'framework', '__id', '__isArgsStory'];

    const stories: Record<StoryId, V3CompatIndexEntry> = mapValues(value.stories, (story) => {
      const { importPath } = this.storyIndex.entries[story.id];
      return {
        ...pick(story, ['id', 'name', 'title']),
        importPath,
        // These 3 fields were going to be dropped in v7, but instead we will keep them for the
        // 7.x cycle so that v7 Storybooks can be composed successfully in v6 Storybook.
        // In v8 we will (likely) completely drop support for `extract` and `getStoriesJsonData`
        kind: story.title,
        story: story.name,
        parameters: {
          ...pick(story.parameters, allowedParameters),
          fileName: importPath,
        },
      };
    });

    return {
      v: 3,
      stories,
    };
  };

  raw(): BoundStory<TRenderer>[] {
    deprecate(
      'StoryStore.raw() is deprecated and will be removed in 9.0, please use extract() instead'
    );
    return Object.values(this.extract())
      .map(({ id }: { id: StoryId }) => this.fromId(id))
      .filter(Boolean) as BoundStory<TRenderer>[];
  }

  fromId(storyId: StoryId): BoundStory<TRenderer> | null {
    deprecate(
      'StoryStore.fromId() is deprecated and will be removed in 9.0, please use loadStory() instead'
    );

    // Deprecated so won't make a proper error for this
    if (!this.cachedCSFFiles)
      // eslint-disable-next-line local-rules/no-uncategorized-errors
      throw new Error('Cannot call fromId/raw() unless you call cacheAllCSFFiles() first.');

    let importPath;
    try {
      ({ importPath } = this.storyIndex.storyIdToEntry(storyId));
    } catch (err) {
      return null;
    }
    const csfFile = this.cachedCSFFiles[importPath];
    const story = this.storyFromCSFFile({ storyId, csfFile });
    return {
      ...story,
      storyFn: (update) => {
        const context = {
          ...this.getStoryContext(story),
          viewMode: 'story',
        } as StoryContext<TRenderer>;

        return story.unboundStoryFn({ ...context, ...update });
      },
    };
  }
}
