/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, TemplateResult, css, PropertyValues, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { until } from 'lit/directives/until.js'
import {
  HomeAssistant,
  hasConfigOrEntityChanged,
  hasAction,
  ActionHandlerEvent,
  handleAction,
  LovelaceCardEditor,
  getLovelace,
  formatNumber,
  formatTime,
  FrontendLocaleData,
} from 'custom-card-helpers'; // This is a community maintained npm module with common helper functions/types. https://github.com/custom-cards/custom-card-helpers
import { isValidColorName, isValidHSL, isValidRGB } from 'is-valid-css-color';

import type {
  ColorConfig,
  ColorDefinition,
  ColorMap,
  ColorObject,
  ColorSettings,
  ConditionSpan,
  ForecastSegment,
  HourlyWeatherCardConfig,
  LocalizerLastSettings,
  RenderTemplateResult,
  SegmentTemperature,
  SegmentWind,
  SegmentPrecipitation,
} from './types';
import { actionHandler } from './action-handler-directive';
import { version } from '../package.json';
import { getLocalizer } from './localize/localize';
import { WeatherBar } from './weather-bar';
import { ICONS, LABELS } from './conditions';
import { DIRECTIONS } from './directions';
customElements.define('weather-bar', WeatherBar);

// Naive localizer is used before we can get at card configuration data
const naiveLocalizer = getLocalizer(void 0, void 0);

/* eslint no-console: 0 */
console.info(
  `%c  HOURLY-WEATHER-CARD \n%c  ${naiveLocalizer('common.version')} ${version}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// This puts your card into the UI card picker dialog
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'hourly-weather',
  name: naiveLocalizer('common.title_card'),
  description: naiveLocalizer('common.description'),
});

@customElement('hourly-weather')
export class HourlyWeatherCard extends LitElement {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import('./editor');
    return document.createElement('hourly-weather-editor');
  }

  public static getStubConfig(): Record<string, unknown> {
    return {};
  }

  // TODO Add any properities that should cause your element to re-render here
  // https://lit.dev/docs/components/properties/
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config!: HourlyWeatherCardConfig;

  @state() private renderedConfig!: Promise<HourlyWeatherCardConfig>;

  private configRenderPending = false;

  private localizer?: ReturnType<typeof getLocalizer> = void 0;
  private localizerLastSettings: LocalizerLastSettings = {
    configuredLanguage: void 0,
    haServerLanguage: void 0
  };

  private _labels = LABELS;
  private labelsLocalized = false;

  private _directions = Object.keys(DIRECTIONS);
  private directionsLocalized = false;

  private localize(string: string, search = '', replace = ''): string {
    if (!this.localizer ||
        this.localizerSettingsChanged) {
      this.localizer = getLocalizer(this.config?.language, this.hass?.locale?.language);
      this.localizerLastSettings.configuredLanguage = this.config?.language;
      this.localizerLastSettings.haServerLanguage = this.hass?.locale?.language;
      this.labelsLocalized = false;
      this.directionsLocalized = false;
    }

    return this.localizer(string, search, replace);
  }

  private get localizerSettingsChanged() {
    return this.localizerLastSettings.configuredLanguage !== this.config?.language ||
      this.localizerLastSettings.haServerLanguage !== this.hass?.locale?.language;
  }

  private get labels() {
    if (!this.labelsLocalized || this.localizerSettingsChanged) {
      this._labels = Object.fromEntries(Object.entries(LABELS).map(([key, msg]) => [key, this.localize(msg)])) as typeof LABELS;
      this.labelsLocalized = true;
    }
    return this._labels;
  }

  private get directions(): Array<string> {
    if (!this.directionsLocalized || this.localizerSettingsChanged) {
      this._directions = Object.values(DIRECTIONS).map((msg) => this.localize(msg));
      // Add North to the end for values approaching 360 degrees.
      this._directions.push(this._directions[0]);
      this.directionsLocalized = true;
    }
    return this._directions;
  }

  // https://lit.dev/docs/components/properties/#accessors-custom
  public setConfig(config: HourlyWeatherCardConfig): void {
    if (!config) {
      throw new Error(this.localize('common.invalid_configuration'));
    }

    if (!config.entity) {
      throw new Error(this.localize('errors.missing_entity'));
    }

    if (config.label_spacing) {
      const numLabelSpacing = parseInt(config.label_spacing, 10);
      if (!Number.isNaN(numLabelSpacing) && (numLabelSpacing < 2 || numLabelSpacing % 2 !== 0)) {
        throw new Error(this.localize('errors.label_spacing_positive_even_int'));
      }
    }

    if (config.test_gui) {
      getLovelace().setEditMode(true);
    }

    this.config = {
      name: this.localize('common.title'),
      ...config,
    };

    this.triggerConfigRender();
  }

  private triggerConfigRender(): void {
    if (!this.hass?.connection) {
      // HASS connection not ready yet, so wait until it is
      this.configRenderPending = true;
      return;
    }
    this.renderedConfig = this.renderConfig();
  }

  private async renderConfig(): Promise<HourlyWeatherCardConfig> {
    const { config } = this;
    if (!config) return config;
    const r: HourlyWeatherCardConfig = {
      ...config,
      num_segments: await this.renderTemplate(config?.num_segments),
      offset: await this.renderTemplate(config?.offset),
      label_spacing: await this.renderTemplate(config?.label_spacing),
      name: await this.renderTemplate(config?.name)
    };

    return r;
  }

  private async renderTemplate(raw: string | undefined): Promise<string | undefined> {
    if (!raw) return raw; // not defined
    if (typeof raw !== 'string') return raw; // not a template
    if (!raw.includes('{{')) return raw; // not a template
    return new Promise(resolve => {
      this.hass.connection.subscribeMessage<RenderTemplateResult>(
        msg => resolve(msg.result),
        {
          type: 'render_template',
          template: raw
        }
      );
    });
  }

  // https://lit.dev/docs/components/lifecycle/#reactive-update-cycle-performing
  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false;
    }

    if (changedProps.has('hass')) {
      const oldHass = changedProps.get('hass') as HomeAssistant;
      if (oldHass && this.hass && JSON.stringify(oldHass.locale) !== JSON.stringify(this.hass.locale)) {
        // Locale changed, so we must re-render
        return true;
      }
    }

    return hasConfigOrEntityChanged(this, changedProps, false);
  }

  protected updated(): void {
    if (this.hass?.connection && this.configRenderPending) {
      this.configRenderPending = false;
      this.triggerConfigRender();
    }
  }

  // https://lit.dev/docs/components/rendering/
  protected render(): TemplateResult | void {
    // Block rendering until templates are rendered
    return html`${until(this.renderCore(), html``)}`;
  }

  private async renderCore(): Promise<TemplateResult | void> {
    const config = await this.renderedConfig;

    if (!config) {
      return;
    }

    const entityId: string = config.entity;
    const state = this.hass.states[entityId];
    const { forecast } = state.attributes as { forecast: ForecastSegment[] };
    const windSpeedUnit = state.attributes.wind_speed_unit ?? '';
    const precipitationUnit = state.attributes.precipitation_unit ?? '';
    const numSegments = parseInt(config.num_segments ?? config.num_hours ?? '12', 10);
    const offset = parseInt(config.offset ?? '0', 10);
    const labelSpacing = parseInt(config.label_spacing ?? '2', 10);
    const forecastNotAvailable = !forecast || !forecast.length;

    if (numSegments < 2) {
      // REMARK: Ok, so I'm re-using a localized string here. Probably not the best, but it avoids repeating for no good reason
      return await this._showError(this.localize('errors.label_spacing_positive_even_int', 'label_spacing', 'num_segments'));
    }

    if (offset < 0) {
      return await this._showError(this.localize('errors.offset_must_be_positive_int'));
    }

    if (!forecastNotAvailable && numSegments > (forecast.length - offset)) {
      return await this._showError(this.localize('errors.too_many_segments_requested'));
    }

    if (labelSpacing < 2 || labelSpacing % 2 !== 0) {
      return await this._showError(this.localize('errors.label_spacing_positive_even_int'));
    }

    if (config.show_wind === 'barb' && typeof forecast[0].wind_bearing === 'string') {
      return await this._showError(this.localize('errors.no_wind_barbs_with_string_bearing'));
    }

    if (forecastNotAvailable) {
      return html`
        <ha-card
          .header=${config.name}
          @action=${this._handleAction}
          .actionHandler=${actionHandler({
        hasHold: hasAction(config.hold_action),
        hasDoubleClick: hasAction(config.double_tap_action),
      })}
          tabindex="0"
          .label=${`Hourly Weather: ${config.entity || 'No Entity Defined'}`}
        >
          <div class="card-content">
            <h3>${ this.localize('errors.forecast_not_available') }</h3>
            <p>${ this.localize('errors.check_entity') }</p>
          </div>
        </ha-card>`;
    }

    const isForecastDaily = this.isForecastDaily(forecast);
    const conditionList = this.getConditionListFromForecast(forecast, numSegments, offset);
    const temperatures = this.getTemperatures(forecast, numSegments, offset);
    const wind = this.getWind(forecast, numSegments, offset, windSpeedUnit);
    const precipitation = this.getPrecipitation(forecast, numSegments, offset, precipitationUnit);

    const colorSettings = this.getColorSettings(config.colors);

    return html`
      <ha-card
        .header=${config.name}
        @action=${this._handleAction}
        .actionHandler=${actionHandler({
      hasHold: hasAction(config.hold_action),
      hasDoubleClick: hasAction(config.double_tap_action),
    })}
        tabindex="0"
        .label=${`Hourly Weather: ${config.entity || 'No Entity Defined'}`}
      >
        <div class="card-content">
          ${isForecastDaily ?
        this._showWarning(this.localize('errors.daily_forecasts')) : ''}
          ${colorSettings.warnings.length ?
        this._showWarning(this.localize('errors.invalid_colors') + ' ' + colorSettings.warnings.join(', ')) : ''}
          <!-- @ts-ignore -->
          <weather-bar
            .conditions=${conditionList}
            .temperatures=${temperatures}
            .wind=${wind}
            .precipitation=${precipitation}
            .icons=${!!config.icons}
            .colors=${colorSettings.validColors}
            .hide_hours=${!!config.hide_hours}
            .hide_temperatures=${!!config.hide_temperatures}
            .show_wind=${config.show_wind}
            .show_precipitation_amounts=${!!config.show_precipitation_amounts}
            .show_precipitation_probability=${!!config.show_precipitation_probability}
            .label_spacing=${labelSpacing}
            .labels=${this.labels}></weather-bar>
        </div>
      </ha-card>
    `;
  }

  private getConditionListFromForecast(forecast: ForecastSegment[], numSegments: number, offset: number): ConditionSpan[] {
    let lastCond: string = forecast[offset].condition;
    let j = 0;
    const res: ConditionSpan[] = [[lastCond, 1]];
    for (let i = offset + 1; i < numSegments + offset; i++) {
      const cond: string = forecast[i].condition;
      if (cond === lastCond) {
        res[j][1]++;
      } else {
        res.push([cond, 1]);
        j++;
        lastCond = cond;
      }
    }
    return res;
  }

  private getTemperatures(forecast: ForecastSegment[], numSegments: number, offset: number): SegmentTemperature[] {
    const temperatures: SegmentTemperature[] = [];
    for (let i = offset; i < numSegments + offset; i++) {
      const fs = forecast[i];
      temperatures.push({
        hour: this.formatHour(new Date(fs.datetime), this.hass.locale),
        temperature: formatNumber(fs.temperature, this.hass.locale)
      })
    }
    return temperatures;
  }

  private getPrecipitation(forecast: ForecastSegment[], numSegments: number, offset: number, unit: string): SegmentPrecipitation[] {
    const precipitation: SegmentPrecipitation[] = [];
    for (let i = offset; i < numSegments + offset; i++) {
      const fs = forecast[i];
      const fs2 = forecast[i+1];
      let amount = '';
      if (fs.precipitation > 0 || fs2.precipitation > 0) {
        amount = `${formatNumber(fs.precipitation+fs2.precipitation, this.hass.locale)} ${unit}`.trim();
      }
      let probability = '';
      let probabilityText = '';
      if (fs.precipitation_probability > 0 || fs2.precipitation_probability > 0) {
        probability = `${formatNumber((fs.precipitation_probability+fs.precipitation_probability)/2, this.hass.locale)}%`.trim();
        probabilityText = this.localize('card.chance_of_precipitation', '{0}', String(fs.precipitation_probability));
      }
      precipitation.push({
        hour: this.formatHour(new Date(fs.datetime), this.hass.locale),
        precipitationAmount: amount,
        precipitationProbability: probability,
        precipitationProbabilityText: probabilityText
      })
    }
    return precipitation;
  }

  private getWind(forecast: ForecastSegment[], numSegments: number, offset: number, speedUnit: string): SegmentWind[] {
    const wind: SegmentWind[] = [];
    for (let i = offset; i < numSegments + offset; i++) {
      const fs = forecast[i];
      let speed = '-';
      let dir = '';
      if (fs.wind_speed > 0) {
        speed = `${Math.round(fs.wind_speed)} ${speedUnit}`.trim();
        dir = this.formatWindDir(fs.wind_bearing);
      }
      wind.push({
        hour: this.formatHour(new Date(fs.datetime), this.hass.locale),
        windSpeed: speed,
        windSpeedRawMS: this.getWindSpeedMS(fs.wind_speed, speedUnit),
        windDirection: dir,
        windDirectionRaw: fs.wind_bearing
      })
    }
    return wind;
  }

  private formatWindDir(degreesOrBearing: number | string): string {
    if (typeof degreesOrBearing === 'string') {
      const lowerBearing = degreesOrBearing.toLowerCase();
      if (lowerBearing in DIRECTIONS) {
        return this.localize(DIRECTIONS[lowerBearing]);
      }
      return degreesOrBearing;
    }
    return this.directions[Math.floor((degreesOrBearing + 11.25) / 22.5)];
  }

  private getWindSpeedMS(speed: number, unit: string): number {
    switch (unit) {
      case 'm/s':
        return speed;
      case 'mph':
        return speed * 0.44704;
      case 'km/h':
        return speed * 0.27777777777778;
      case 'ft/s':
        return speed * 0.3048;
      case 'kt':
      case 'kn':
        return speed * 0.51444444444444;
    }
    return -1;
  }

  private isForecastDaily(forecast: ForecastSegment[]): boolean {
    const dates = forecast.map(f => new Date(f.datetime).getDate());
    const uniqueDates = new Set(dates);
    return uniqueDates.size >= forecast.length - 1;
  }

  private formatHour(time: Date, locale: FrontendLocaleData): string {
    const formatted = formatTime(time, locale);
    if (formatted.includes('AM') || formatted.includes('PM')) {
      // Drop ':00' in 12 hour time
      return formatted.replace(':00', '');
    }
    return formatted;
  }

  private getColorSettings(colorConfig?: ColorConfig): ColorSettings {
    if (!colorConfig) return {
      validColors: void 0,
      warnings: []
    };

    const validColors: ColorMap = new Map();
    const warnings: string[] = [];
    Object.entries(colorConfig).forEach(([k, v]) => {
      if (this.isValidColorDefinition(k, v))
        validColors.set(k as keyof ColorConfig, HourlyWeatherCard.toColorObject(v));
      else
        warnings.push(`${k}: ${JSON.stringify(v, null, 2)}`);
    });
    return {
      validColors,
      warnings
    };
  }

  private isValidColorDefinition(key: string, color: ColorDefinition): boolean {
    if (!(key in ICONS)) {
      return false;
    }
    if (typeof color === 'string') {
      if (!HourlyWeatherCard.isValidColor(color)) return false;
    } else {
      if (!color.background && !color.foreground) return false;
      if (color.background && !HourlyWeatherCard.isValidColor(color.background)) return false;
      if (color.foreground && !HourlyWeatherCard.isValidColor(color.foreground)) return false;
    }

    return true;
  }

  private static isValidColor(color: string): boolean {
    if (!(isValidRGB(color) ||
      isValidColorName(color) ||
      isValidHSL(color))) {
      return false;
    }

    return true;
  }

  private static toColorObject(color: string | ColorObject): ColorObject {
    if (typeof color === 'string') {
      return {
        background: color
      };
    }
    return color;
  }

  private _handleAction(ev: ActionHandlerEvent): void {
    if (this.hass && this.config && ev.detail.action) {
      handleAction(this, this.hass, this.config, ev.detail.action);
    }
  }

  private _showWarning(warning: string): TemplateResult {
    return html` <hui-warning>${warning}</hui-warning> `;
  }

  private async _showError(error: string): Promise<TemplateResult> {
    // Without this next line, we get an error accessing `setConfig` on `errorCard`, likely due to a race condition in
    // Home Assistant's lovelace logic. This line just triggers a stack unroll before we continue rendering. That deals
    // with the race condition effectively, it seems.
    await new Promise(resolve => setTimeout(resolve, 0));
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config,
    });

    return html` ${errorCard} `;
  }

  // https://lit.dev/docs/components/styles/
  static get styles(): CSSResultGroup {
    return css``;
  }
}
