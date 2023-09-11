import React, { useState } from "react";
import { IconButton, Tooltip, Typography } from "@mui/material";
import InfoOutlined from "./InfoOutlined";

export default function TooltipIcon(props: { title: string | React.ReactNode }): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <Tooltip
            disableInteractive
            arrow
            open={open}
            onClose={() => setOpen(false)}
            onOpen={() => setOpen(true)}
            title={(
                <Typography>
                    {props.title}
                </Typography>
            )}
        >
            <IconButton
                size='small'
                onSubmit={() => setOpen(!open)}>
                <InfoOutlined fontSize='small' color='disabled' />
            </IconButton>
        </Tooltip>
    )
};
