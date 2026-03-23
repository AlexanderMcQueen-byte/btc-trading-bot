// Dynamically loads strategy plugins
import path from 'path';

export async function loadStrategy(strategyName) {
    const strategyPath = path.resolve('modules', `${strategyName}.js`);
    const module = await import(strategyPath);
    return module.default;
}
