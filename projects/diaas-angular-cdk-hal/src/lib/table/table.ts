/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {Directionality} from '@angular/cdk/bidi';
import {CollectionViewer, DataSource, isDataSource} from '@angular/cdk/collections';
import { DOCUMENT } from '@angular/common';
import {
  AfterContentChecked,
  Attribute,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ContentChildren,
  Directive,
  ElementRef,
  EmbeddedViewRef,
  Inject,
  Input,
  isDevMode,
  IterableChangeRecord,
  IterableDiffer,
  IterableDiffers,
  OnDestroy,
  OnInit,
  Optional,
  QueryList,
  TemplateRef,
  TrackByFunction,
  ViewChild,
  ViewContainerRef,
  ViewEncapsulation,
  ComponentFactoryResolver,
  HostBinding
} from '@angular/core';
import {
  BehaviorSubject,
  Observable,
  of as observableOf,
  Subject,
  Subscription,
  isObservable,
} from 'rxjs';
import {takeUntil} from 'rxjs/operators';
import {
  DxcCellOutlet,
  DxcCellOutletRowContext
} from './row';
import {
  getTableUnknownDataSourceError
} from './table-errors';
import {DXC_HAL_TABLE} from './tokens';
import { TableSpinnerComponent } from './components/table-spinner/table-spinner.component';
import { DxcHeaderRowComponent } from './components/dxc-header-row/dxc-header-row.component';
import { DxcRowComponent } from './components/dxc-row/dxc-row.component';
import { DxcColumnDef } from './directives/dxc-column-def.directive';
import { HttpHeaders, HttpClient } from '@angular/common/http';
import { SortService } from './services/sort.service';
import { Ordering } from './directives/sorting.directive';
import { HalResourceService } from '../diaas-angular-cdk-hal.service';

/** Interface used to provide an outlet for rows to be inserted into. */
export interface RowOutlet {
  viewContainer: ViewContainerRef;
}

/**
 * Union of the types that can be set as the data source for a `CdkTable`.
 * @docs-private
 */
type DxcHalTableDataSourceInput<T> =
    DataSource<T>|Observable<ReadonlyArray<T>|T[]>|ReadonlyArray<T>|T[];

/**
 * Provides a handle for the table to grab the view container's ng-container to insert spinner.
 * @docs-private
 */
@Directive({selector: '[spinnerOutlet]'})
export class SpinnerOutlet implements RowOutlet {
  constructor(public viewContainer: ViewContainerRef, public elementRef: ElementRef) {}
}

/**
 * Provides a handle for the table to grab the view container's ng-container to insert data rows.
 * @docs-private
 */
@Directive({selector: '[headerOutlet]'})
export class HeaderOutlet implements RowOutlet {
  constructor(public viewContainer: ViewContainerRef, public elementRef: ElementRef) {}
}


/**
 * Provides a handle for the table to grab the view container's ng-container to insert data rows.
 * @docs-private
 */
@Directive({selector: '[rowOutlet]'})
export class DataRowOutlet implements RowOutlet {
  constructor(public viewContainer: ViewContainerRef, public elementRef: ElementRef) {}
}



/**
 * Interface used to conveniently type the possible context interfaces for the render row.
 * @docs-private
 */
export interface RowContext<T> extends DxcCellOutletRowContext<T> {}

/**
 * Class used to conveniently type the embedded view ref for rows with a context.
 * @docs-private
 */
abstract class RowViewRef<T> extends EmbeddedViewRef<RowContext<T>> {}

/**
 * Set of properties that represents the identity of a single rendered row.
 *
 * When the table needs to determine the list of rows to render, it will do so by iterating through
 * each data object and evaluating its list of row templates to display (when multiTemplateDataRows
 * is false, there is only one template per data object). For each pair of data object and row
 * template, a `RenderRow` is added to the list of rows to render. If the data object and row
 * template pair has already been rendered, the previously used `RenderRow` is added; else a new
 * `RenderRow` is * created. Once the list is complete and all data objects have been itereated
 * through, a diff is performed to determine the changes that need to be made to the rendered rows.
 *
 * @docs-private
 */
export interface RenderRow<T> {
  data: T;
  dataIndex: number;
  rowDef: Object;
}

export interface Columns {
    columns: Array<string>;
    labels:Array<string>;
}
/**
 * The table template that can be used by the mat-table. Should not be used outside of the
 * material library.
 * @docs-private
 */
export const CDK_TABLE_TEMPLATE =
    `
    <dxc-table [margin]="margin">
      <ng-container headerOutlet>
      </ng-container>
      <ng-container rowOutlet>
      </ng-container>
    </dxc-table>

    <ng-container spinnerOutlet>
      </ng-container>

    <dxc-paginator *ngIf="(totalItems | async) !== null"
      [totalItems]="totalItems | async"
      [itemsPerPage]="itemsPerPage"
      [currentPage]="page"
      (nextFunction)="navigate($event, 'next')"
      (prevFunction)="navigate($event, 'prev')"
      (firstFunction)="navigate($event, 'first')"
      (lastFunction)="navigate($event, 'last')"
    ></dxc-paginator>

`;
/**
 * A data table that can render a header row, data rows, and a footer row.
 * Uses the dataSource input to determine the data to be rendered. The data can be provided either
 * as a data array, an Observable stream that emits the data array to render, or a DataSource with a
 * connect function that will return an Observable stream that emits the data array to render.
 */
@Component({
  selector: 'dxc-hal-table, table[dxc-hal-table]',
  exportAs: 'dxcHalTable',
  template: CDK_TABLE_TEMPLATE,
  encapsulation: ViewEncapsulation.None,
  // The "OnPush" status for the `MatTable` component is effectively a noop, so we are removing it.
  // The view for `MatTable` consists entirely of templates declared in other views. As they are
  // declared elsewhere, they are checked when their declaration points are checked.
  // tslint:disable-next-line:validate-decorators
  changeDetection: ChangeDetectionStrategy.Default,
  providers: [{provide: DXC_HAL_TABLE, useExisting: DxcHalTable}, SortService]
})
export class DxcHalTable<T> implements AfterContentChecked, CollectionViewer, OnDestroy, OnInit {

  @Input()
  itemsPerPage: number = 5;

  @Input()
  halUrl;

  @Input()
  headers:any;

  @Input() margin:string;

  @HostBinding("class") className;

  collectionResource: HalResourceService;

  displayedColumns:string[] = [];

  totalItems;

  fetchStatus;

  page : number = 1;

  private _document: Document;

  /** List of ordering directives. */
  private _allOrderingRefs: Ordering[] = [];

  /** Latest data provided by the data source. */
  protected _data: T[]|ReadonlyArray<T>;

  /** Subject that emits when the component has been destroyed. */
  private _onDestroy = new Subject<void>();

  /** List of the rendered rows as identified by their `RenderRow` object. */
  private _renderRows: RenderRow<T>[];

  /** Subscription that listens for the data provided by the data source. */
  private _renderChangeSubscription: Subscription|null;

  /**
   * Map of all the user's defined columns (header, data, and footer cell template) identified by
   * name. Collection populated by the column definitions gathered by `ContentChildren` as well as
   * any custom column definitions added to `_customColumnDefs`.
   */
  private _columnDefsByName = new Map<string, DxcColumnDef>();

  /**
   * Set of all row definitions that can be used by this table. Populated by the rows gathered by
   * using `ContentChildren` as well as any custom row definitions added to `_customRowDefs`.
   */
  //private _rowDefs: CdkRowDef<T>[];

  /** Differ used to find the changes in the data provided by the data source. */
  private _dataDiffer: IterableDiffer<RenderRow<T>>;

  /**
   * Column definitions that were defined outside of the direct content children of the table.
   * These will be defined when, e.g., creating a wrapper around the cdkTable that has
   * column definitions as *its* content child.
   */
  private _customColumnDefs = new Set<DxcColumnDef>();

  /**
   * Cache of the latest rendered `RenderRow` objects as a map for easy retrieval when constructing
   * a new list of `RenderRow` objects for rendering rows. Since the new list is constructed with
   * the cached `RenderRow` objects when possible, the row identity is preserved when the data
   * and row template matches, which allows the `IterableDiffer` to check rows by reference
   * and understand which rows are added/moved/removed.
   *
   * Implemented as a map of maps where the first key is the `data: T` object and the second is the
   * `CdkRowDef<T>` object. With the two keys, the cache points to a `RenderRow<T>` object that
   * contains an array of created pairs. The array is necessary to handle cases where the data
   * array contains multiple duplicate data objects and each instantiated `RenderRow` must be
   * stored.
   */
  private _cachedRenderRowsMap = new Map<T, WeakMap<Object, RenderRow<T>[]>>();

  /** Whether the table is applied to a native `<table>`. */
  private _isNativeHtmlTable: boolean;

  /**
   * Tracking function that will be used to check the differences in data changes. Used similarly
   * to `ngFor` `trackBy` function. Optimize row operations by identifying a row based on its data
   * relative to the function to know if a row should be added/removed/moved.
   * Accepts a function that takes two parameters, `index` and `item`.
   */
  @Input()
  get trackBy(): TrackByFunction<T> {
    return this._trackByFn;
  }
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console &&
        <any>console.warn) {
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);
    }
    this._trackByFn = fn;
  }
  private _trackByFn: TrackByFunction<T>;

  private dataSource: DxcHalTableDataSourceInput<T>;

  // TODO(andrewseguin): Remove max value as the end index
  //   and instead calculate the view on init and scroll.
  /**
   * Stream containing the latest information on what rows are being displayed on screen.
   * Can be used by the data source to as a heuristic of what data should be provided.
   *
   * @docs-private
   */
  viewChange: BehaviorSubject<{start: number, end: number}> =
      new BehaviorSubject<{start: number, end: number}>({start: 0, end: Number.MAX_VALUE});

  // Outlets in the table's template where the header, data rows, and footer will be inserted.
  @ViewChild(SpinnerOutlet, {static: true}) _spinnerOutlet: SpinnerOutlet;
  @ViewChild(HeaderOutlet, {static: true}) _headerOutlet: HeaderOutlet;
  @ViewChild(DataRowOutlet, {static: true}) _rowOutlet: DataRowOutlet;

  /**
   * The column definitions provided by the user that contain what the header, data, and footer
   * cells should render for each column.
   */
  @ContentChildren(DxcColumnDef, {descendants: true}) _contentColumnDefs: QueryList<DxcColumnDef>;

  constructor(
      protected readonly _differs: IterableDiffers,
      protected readonly _changeDetectorRef: ChangeDetectorRef,
      protected readonly _elementRef: ElementRef, @Attribute('role') role: string,
      private httpClient: HttpClient,
      @Optional() protected readonly _dir: Directionality, @Inject(DOCUMENT) _document: any,
      private resolver: ComponentFactoryResolver, private sortService: SortService) {



    if (!role) {
      this._elementRef.nativeElement.setAttribute('role', 'grid');
    }

    this._document = _document;
    this._isNativeHtmlTable = this._elementRef.nativeElement.nodeName === 'TABLE';

    this.setClassName();
  }

  ngOnInit() {
    this.collectionResource = new HalResourceService(this.halUrl,new HttpHeaders(this.headers), this.httpClient);

    this.totalItems = this.collectionResource.totalItems;
    this.fetchStatus = this.collectionResource.fetchStatus;
    this.dataSource = new TableDataSource(this.collectionResource.items);

    this.collectionResource.handleGet({
      _start: this.page,
      _num: this.itemsPerPage
    });

    if (this._isNativeHtmlTable) {
      this._applyNativeTableSections();
    }


    // Set up the trackBy function so that it uses the `RenderRow` as its identity by default. If
    // the user has provided a custom trackBy, return the result of that function as evaluated
    // with the values of the `RenderRow`'s data and index.
    this._dataDiffer = this._differs.find([]).create((_i: number, dataRow: RenderRow<T>) => {
      return this.trackBy ? this.trackBy(dataRow.dataIndex, dataRow.data) : dataRow;
    });
  }

  ngAfterContentChecked() {
    // Cache the row and column definitions gathered by ContentChildren and programmatic injection.
    //this._cacheRowDefs();


    this._cacheColumnDefs();


    // Render updates if the list of columns have been changed for the header, row, or footer defs.


    // If there is a data source and row definitions, connect to the data source unless a
    // connection has already been made.
    if (this.dataSource  && !this._renderChangeSubscription) {
      this._observeRenderChanges();
    }

  }

  ngOnDestroy() {
    this._headerOutlet.viewContainer.clear();
    this._spinnerOutlet.viewContainer.clear();
    this._rowOutlet.viewContainer.clear();
    this._cachedRenderRowsMap.clear();
    this._onDestroy.next();
    this._onDestroy.complete();

    if (isDataSource(this.dataSource)) {
      this.dataSource.disconnect(this);
    }
  }

  renderHeaders(){
    this._headerOutlet.viewContainer.clear();
    if (this._columnDefsByName !== null ){

      this._columnDefsByName.forEach((value: DxcColumnDef , key: string) => {
        const factory = this.resolver.resolveComponentFactory(DxcHeaderRowComponent);
        const viewRef = this._headerOutlet.viewContainer.createComponent(factory);
        viewRef.instance.columnName = key;
        viewRef.instance.isSortable = value.sortable.isSortable; //Save if header is sortable in the created component
        viewRef.instance.state = this.getMapStateHeaders().get(key); //Get header's current state for sorting and save it in the created component
        viewRef.instance.parentClassName = this.className; // just in case there ar more tables in the page
        viewRef.instance.value = value.sortable.propertyName;
        if (!this.displayedColumns.includes(key)){
          this.displayedColumns.push( key );
        }
      });
    }
  }


  /**
   * Renders rows based on the table's latest set of data, which was either provided directly as an
   * input or retrieved through an Observable stream (directly or from a DataSource).
   * Checks for differences in the data since the last diff to perform only the necessary
   * changes (add/remove/move rows).
   *
   * If the table's data source is a DataSource or Observable, this will be invoked automatically
   * each time the provided Observable stream emits a new data array. Otherwise if your data is
   * an array, this function will need to be called to render any changes.
   */
  renderRows() {
    this._renderRows = this._getAllRenderRows();
    const changes = this._dataDiffer.diff(this._renderRows);
    if (!changes) {
      return;
    }
    const viewContainer = this._rowOutlet.viewContainer;
    changes.forEachOperation(
        (record: IterableChangeRecord<RenderRow<T>>, prevIndex: number|null,
         currentIndex: number|null) => {
          if (record.previousIndex == null) {
            this._insertRow(record.item, currentIndex!);
          } else if (currentIndex == null) {
            viewContainer.remove(prevIndex!);
          } else {
            const view = <RowViewRef<T>>viewContainer.get(prevIndex!);
            viewContainer.move(view!, currentIndex);
          }
        });

    // Update the meta context of a row's context data (index, count, first, last, ...)
    this._updateRowIndexContext();

    // Update rows that did not get added/removed/moved but may have had their identity changed,
    // e.g. if trackBy matched data on some property but the actual data reference changed.
    changes.forEachIdentityChange((record: IterableChangeRecord<RenderRow<T>>) => {
      const rowView = <RowViewRef<T>>viewContainer.get(record.currentIndex!);
      rowView.context.$implicit = record.item.data;
    });

    this._spinnerOutlet.viewContainer.clear();
  }

  renderSpinner(outlet: RowOutlet){
    const spinnerOutletContainer =  outlet.viewContainer;
    const spinnerComponentFactory = this.resolver.resolveComponentFactory(TableSpinnerComponent);
    spinnerOutletContainer.createComponent(spinnerComponentFactory);


    // const helloComponentRef:ComponentRef<DxcSpinnerComponent> = spinnerViewContainer.createComponent(spinnerComponentFactory);
    // const spinnerView: ViewRef = helloComponentRef.hostView;
  }

  /**
   * Get the list of RenderRow objects to render according to the current list of data and defined
   * row definitions. If the previous list already contained a particular pair, it should be reused
   * so that the differ equates their references.
   */
  private _getAllRenderRows(): RenderRow<T>[] {
    const renderRows: RenderRow<T>[] = [];

    // Store the cache and create a new one. Any re-used RenderRow objects will be moved into the
    // new cache while unused ones can be picked up by garbage collection.
    const prevCachedRenderRows = this._cachedRenderRowsMap;
    this._cachedRenderRowsMap = new Map();

    // For each data object, get the list of rows that should be rendered, represented by the
    // respective `RenderRow` object which is the pair of `data` and `CdkRowDef`.
    for (let i = 0; i < this._data.length; i++) {
      let data = this._data[i]['summary'];
      const renderRowsForData = this._getRenderRowsForData(data, i, prevCachedRenderRows.get(data));

      if (!this._cachedRenderRowsMap.has(data)) {
        this._cachedRenderRowsMap.set(data, new WeakMap());
      }

      for (let j = 0; j < renderRowsForData.length; j++) {
        let renderRow = renderRowsForData[j];
        const cache = this._cachedRenderRowsMap.get(renderRow.data)!;
        if (cache.has(renderRow.data)) {
          cache.get(renderRow.data)!.push(renderRow);
        } else {
          cache.set(renderRow.data, [renderRow]);
          renderRows.push(renderRow);
        }
      }
    }

    return renderRows;
  }

  /**
   * Gets a list of `RenderRow<T>` for the provided data object and any `DxcRowDef` objects that
   * should be rendered for this data. Reuses the cached RenderRow objects if they match the same
   * `(T, DxcRowDef)` pair.
   */
  private _getRenderRowsForData(
      data: T, dataIndex: number, cache?: WeakMap<Object, RenderRow<T>[]>): RenderRow<T>[] {
    return this.displayedColumns.map(rowDef => {
      const cachedRenderRows = (cache && cache.has(rowDef)) ? cache.get(rowDef)! : [];
      if (cachedRenderRows.length) {
        const dataRow = cachedRenderRows.shift()!;
        dataRow.dataIndex = dataIndex;
        return dataRow;
      } else {
        return {data, rowDef, dataIndex};
      }
    });
  }

  /** Update the map containing the content's column definitions. */
  private _cacheColumnDefs() {
    this._columnDefsByName.clear();
    const columnDefs = mergeArrayAndSet(
        this._getOwnDefs(this._contentColumnDefs), this._customColumnDefs);
    columnDefs.forEach(columnDef => {
      // if (this._columnDefsByName.has(columnDef.name)) {
      //   throw getTableDuplicateColumnNameError(columnDef.name);
      // }
      this._columnDefsByName.set(columnDef.name, columnDef);
    });
  }

 /**
   * Switch to the provided data source by resetting the data and unsubscribing from the current
   * render change subscription if one exists. If the data source is null, interpret this by
   * clearing the row outlet. Otherwise start listening for new data.
   */
  private _switchDataSource(dataSource: DxcHalTableDataSourceInput<T>) {
    this._data = [];

    if (isDataSource(this.dataSource)) {
      this.dataSource.disconnect(this);
    }

    // Stop listening for data from the previous data source.
    if (this._renderChangeSubscription) {
      this._renderChangeSubscription.unsubscribe();
      this._renderChangeSubscription = null;
    }

    if (!dataSource) {
      if (this._dataDiffer) {
        this._dataDiffer.diff([]);
      }
      this._rowOutlet.viewContainer.clear();
    }

  }

  /** Set up a subscription for the data provided by the data source. */
  private _observeRenderChanges() {
    // If no data source has been set, there is nothing to observe for changes.
    if (!this.dataSource) {
      return;
    }

    let dataStream: Observable<T[]|ReadonlyArray<T>>|undefined;

    if (isDataSource(this.dataSource)) {
      dataStream = this.dataSource.connect(this);
    } else if (isObservable(this.dataSource)) {
      dataStream = this.dataSource;
    } else if (Array.isArray(this.dataSource)) {
      dataStream = observableOf(this.dataSource);
    }

    if (dataStream === undefined) {
      throw getTableUnknownDataSourceError();
    }


    this._renderChangeSubscription = dataStream.pipe(takeUntil(this._onDestroy)).subscribe(data => {
      this._data = data || [];
      this.renderSpinner(this._spinnerOutlet);
      this.renderHeaders();
      this.renderRows();
    });
  }

  /** Gets the list of rows that have been rendered in the row outlet. */
  _getRenderedRows(rowOutlet: RowOutlet): HTMLElement[] {
    const renderedRows: HTMLElement[] = [];
    for (let i = 0; i < rowOutlet.viewContainer.length; i++) {
      const viewRef = (rowOutlet.viewContainer.get(i)! as EmbeddedViewRef<any>);
      renderedRows.push(viewRef.rootNodes[0]);
    }

    return renderedRows;
  }

  /**
   * Create the embedded view for the data row template and place it in the correct index location
   * within the data row view container.
   */
  private _insertRow(renderRow: RenderRow<T>, renderIndex: number) {
    const context: RowContext<T> = {$implicit: renderRow.data};
    this._renderRow(this._rowOutlet,renderRow, renderIndex, context);
  }

  /**
   * Creates a new row template in the outlet and fills it with the set of cell templates.
   * Optionally takes a context to provide to the row and cells, as well as an optional index
   * of where to place the new row template in the outlet.
   */
  private _renderRow(
      outlet: RowOutlet,renderRow: Object, index: number, context: RowContext<T> = {}) {
    // TODO(andrewseguin): enforce that one outlet was instantiated from createEmbeddedView
    const factory = this.resolver.resolveComponentFactory(DxcRowComponent);
    outlet.viewContainer.createComponent(factory, index);
    //outlet.viewContainer.createEmbeddedView(this.cdkRow.template, context, index);

    for (let cellTemplate of this._getCellTemplates(renderRow)) {
      if (DxcCellOutlet.mostRecentCellOutlet) {
        DxcCellOutlet.mostRecentCellOutlet._viewContainer.createEmbeddedView(cellTemplate, context);
      }
    }

    this._changeDetectorRef.markForCheck();
  }

  /**
   * Updates the index-related context for each row to reflect any changes in the index of the rows,
   * e.g. first/last/even/odd.
   */
  private _updateRowIndexContext() {
    const viewContainer = this._rowOutlet.viewContainer;
    for (let renderIndex = 0, count = viewContainer.length; renderIndex < count; renderIndex++) {
      const viewRef = viewContainer.get(renderIndex) as RowViewRef<T>;
      if (viewRef !== null && viewRef.context !== null){
        const context = viewRef.context as RowContext<T>;
        context.count = count;
        context.first = renderIndex === 0;
        context.last = renderIndex === count - 1;
        context.even = renderIndex % 2 === 0;
        context.odd = !context.even;
        context.index = this._renderRows[renderIndex].dataIndex;
      }

    }
  }

  /** Gets the column definitions for the provided row def. */
  private _getCellTemplates(rowDef: Object): TemplateRef<any>[] {
    if (!rowDef || !this.displayedColumns) {
      return [];
    }
    return Array.from(this.displayedColumns, columnId => {
      const column = this._columnDefsByName.get(columnId);

      return column.cell.template;
    });
  }

  /** Adds native table sections (e.g. tbody) and moves the row outlets into them. */
  private _applyNativeTableSections() {
    const documentFragment = this._document.createDocumentFragment();
    const sections = [
      // {tag: 'thead', outlet: this._headerRowOutlet},
      {tag: 'tbody', outlet: this._rowOutlet}
    ];

    for (const section of sections) {
      const element = this._document.createElement(section.tag);
      element.setAttribute('role', 'rowgroup');
      element.appendChild(section.outlet.elementRef.nativeElement);
      documentFragment.appendChild(element);
    }

    // Use a DocumentFragment so we don't hit the DOM on each iteration.
    this._elementRef.nativeElement.appendChild(documentFragment);
  }

  /**
   * Forces a re-render of the data rows. Should be called in cases where there has been an input
   * change that affects the evaluation of which rows should be rendered, e.g. toggling
   * `multiTemplateDataRows` or adding/removing row definitions.
   */
  private _forceRenderDataRows() {
    this._dataDiffer.diff([]);
    this._rowOutlet.viewContainer.clear();
    this.renderRows();
  }

  /** Filters definitions that belong to this table from a QueryList. */
  private _getOwnDefs<I extends {_table?: any}>(items: QueryList<I>): I[] {
    return items.filter(item => !item._table || item._table === this);
  }

  navigate(page: number, operation:string){
    switch (operation) {
      case 'next':
        this.page=page;
        return this.collectionResource.handleGet({
          _start: this.page,
          _num: this.itemsPerPage
        });
      case 'first':
        this.page=page;
        return this.collectionResource.handleGet({
          _start: this.page,
          _num: this.itemsPerPage
        });
      case 'prev':
        this.page=page;
        return this.collectionResource.handleGet({
          _start: this.page,
          _num: this.itemsPerPage
        });
      case 'last':
        this.page=page;
        return this.collectionResource.handleGet({
          _start: this.page,
          _num: this.itemsPerPage
        });
      default:
        this.collectionResource.buildErrorResponse({
          message: `Error. Operation  ${operation} is not known.`
        });
        break;
    }
  }

      //It is needed to give a unique id to the resultset table
  private setClassName(){
        this.className =  `${Math.round(Math.random() * 100)}`;
      }

      /** Set to default others header's states if they are different to default state ("up" or "down"). */
  removeOtherSorts(actualIdHeader){
    this._allOrderingRefs.forEach(element => {
      let nativeElement = element.elementRef.nativeElement;
      if(actualIdHeader != nativeElement.id){
        let stateElement = nativeElement.getAttribute("state");
        if(stateElement === "up" || stateElement === "down"){
          this.sortService.removeOtherSortings(nativeElement.id);
        }
      }
    });
  }

  ngAfterViewInit(): void {
    this.setDefaultStateHeaders();
  }

  /** Set to default all headers that are sortable. */
  setDefaultStateHeaders(){
    this._allOrderingRefs.forEach(element => {
      let id = element.elementRef.nativeElement.id;
      let columnName = id.split("-")[1];
      this.sortService.mapStatesHeaders.set(columnName, "default");
    });
  }

  /** Register all ordering directives references. */
  registerOrderingRef(ref: Ordering) {
    this._allOrderingRefs.push(ref);
  }

  /** Sort row elements from given column depending on given state. */
  sortCells(value,state) {
    if(state === "up"){
      return this.collectionResource.handleGet({
        _start: this.page,
        _num: this.itemsPerPage,
        _sort: `${value}`
      });
    }
    else if(state === "down"){
      return this.collectionResource.handleGet({
        _start: this.page,
        _num: this.itemsPerPage,
        _sort: `${value}`
      });
    }
  }

  /** Change icon to up icon */
  changeAscIcon(el: Ordering){
    this.sortService.setAscIconSort(el);
  }

  /** Change icon to down icon */
  changeDescIcon(el: Ordering){
    this.sortService.setDescIconSort(el);
  }

  /** Change icon to default icon */
  changeDefaultIcon(el: Ordering){
    this.sortService.setDefaultIconSort(el);
  }

  /** Return map with header's states */
  getMapStateHeaders(){
    return this.sortService.mapStatesHeaders;
  }
}

/** Utility function that gets a merged list of the entries in an array and values of a Set. */
function mergeArrayAndSet<T>(array: T[], set: Set<T>): T[] {
  return array.concat(Array.from(set));
}


export class TableDataSource extends DataSource<any> {
  /** Stream of data that is provided to the table. */

  data = new BehaviorSubject<[]>([]);

  constructor(items){
    super();
    this.data = items;
  }

  /** Connect function called by the table to retrieve one stream containing the data to render. */
  connect(): Observable<[]> {
    return this.data;
  }

  disconnect() {}
}
