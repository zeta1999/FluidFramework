import { Template, Dom } from "@prague/flow-util";
import * as styles from "./index.css";
import { IViewState, View } from "..";

const template = new Template({ 
    tag: "p",
    props: { className: styles.inclusion },
});

export interface IInclusionProps { root: Node }
export interface IInclusionViewState extends IViewState {
    cursorTarget?: Node;
}

export class InclusionView extends View<IInclusionProps, IInclusionViewState> {
    public static readonly instance = new InclusionView();

    mounting(props: Readonly<IInclusionProps>): IInclusionViewState {
        const root = template.clone();
        return this.update( props, { root });
    }

    updating(props: Readonly<IInclusionProps>, state: Readonly<IInclusionViewState>): IInclusionViewState {
        const parent = state.root;
        const desiredChild = props.root;

        if (parent.firstChild !== desiredChild) {
            Dom.replaceFirstChild(parent, desiredChild);
            state = { root: state.root, cursorTarget: desiredChild };
        }
        
        return state;
    }

    unmounting(state: Readonly<IInclusionViewState>) { }
}